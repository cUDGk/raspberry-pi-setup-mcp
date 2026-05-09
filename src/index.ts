#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { OS_CATALOG, recommendOs } from "./os.js";
import {
  cloudInitYaml,
  dietpiTxt,
  dietpiWifiTxt,
  listBlockDevices,
  generateSshKeypair,
} from "./extras.js";

// B4: set restrictive umask process-wide so all writeFileSync calls produce at most 0600/0644
// regardless of the parent shell's inherited umask.
// On Windows process.umask() is a no-op — mode is handled at the writeFileSync call site.
if (process.platform !== "win32") process.umask(0o077);

// B23: server version from package.json
const require_ = createRequire(import.meta.url);
const PKG = require_("../package.json") as { version: string };

const SPAWN_TIMEOUT_MS = 15_000;

// ===========================================================================
// Validation primitives — each input here can become root-RCE on the Pi if
// not validated. See README "Security model".  (S1)
// ===========================================================================

const RX_HOSTNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const RX_USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const RX_LOCALE = /^[a-z]{2,3}_[A-Z]{2}\.[A-Z0-9-]{1,20}$/;
const RX_COUNTRY = /^[A-Z]{2}$/;
const RX_TZ_FALLBACK = /^[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)*$/;
const SSH_KEY_PREFIXES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
];
const RX_CRYPT_HASH = /^\$6\$[^\n\r:]{10,106}$|^\$y\$[^\n\r:]{10,128}$/;

function validateHostname(s: string): string {
  if (!RX_HOSTNAME.test(s)) throw new Error(`invalid hostname '${s}' (RFC 1123: ^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$)`);
  return s;
}

function validateUsername(s: string): string {
  if (!RX_USERNAME.test(s)) throw new Error(`invalid username '${s}' (POSIX: ^[a-z_][a-z0-9_-]{0,31}$)`);
  return s;
}

function validateTimezone(s: string): string {
  // Prefer the runtime's IANA list when available
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    const list = supported.call(Intl, "timeZone");
    if (Array.isArray(list) && list.length > 0) {
      if (!list.includes(s)) throw new Error(`invalid timezone '${s}' (not in IANA list)`);
      return s;
    }
  }
  if (!RX_TZ_FALLBACK.test(s)) throw new Error(`invalid timezone '${s}'`);
  return s;
}

function validateLocale(s: string): string {
  if (!RX_LOCALE.test(s)) throw new Error(`invalid locale '${s}' (expected like 'ja_JP.UTF-8')`);
  return s;
}

function validateCountry(s: string): string {
  if (!RX_COUNTRY.test(s)) throw new Error(`invalid country '${s}' (expected ISO 3166-1 alpha-2 uppercase)`);
  return s;
}

function validateSshPubkey(s: string): string {
  if (!s) throw new Error("ssh_pubkey is empty");
  if (/[\n\r\\$`"()|<>&;']/.test(s)) throw new Error("ssh_pubkey contains disallowed characters");
  const head = s.split(/\s+/)[0];
  if (!head || !SSH_KEY_PREFIXES.includes(head)) {
    throw new Error(`ssh_pubkey must start with one of: ${SSH_KEY_PREFIXES.join(", ")}`);
  }
  return s;
}

function validateCommands(cmds: string[]): string[] {
  for (const c of cmds) {
    if (typeof c !== "string") throw new Error("firstrun_commands entries must be strings");
    if (/[\n\r]/.test(c)) {
      throw new Error("firstrun_commands entries must not contain newlines (one command per line)");
    }
  }
  return cmds;
}

function validatePackages(pkgs: string[]): void {
  for (const p of pkgs) {
    if (typeof p !== "string") throw new Error("packages entries must be strings");
    if (/[\n\r]/.test(p)) throw new Error("packages entries must not contain newlines");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.+\-]{0,127}$/.test(p)) {
      throw new Error(`invalid package name '${p}' (expected Debian-style: alphanumeric, +, -, .)`);
    }
  }
}

function validateSimpleToken(label: string, s: string): void {
  // For keyboard_layout and autostart index — no newlines, no shell metacharacters
  if (s.length > 64) throw new Error(`${label} exceeds 64-character limit`);
  if (/[\n\r;&|`$\\]/.test(s)) {
    throw new Error(`${label} must not contain newlines or shell metacharacters`);
  }
}

function validateSsidPsk(ssid: string, psk?: string, key_mgmt?: "WPA-PSK" | "NONE"): void {
  if (!ssid || ssid.length === 0) throw new Error("ssid must not be empty");
  if (/[\n\r\\'"]/.test(ssid)) throw new Error("ssid must not contain newline, backslash, single-quote, or double-quote");
  if (psk !== undefined) {
    if (/[\n\r\\'"]/.test(psk)) throw new Error("psk: same restrictions (no newline, backslash, single-quote, or double-quote)");
    if (psk.length < 8 || psk.length > 63) {
      throw new Error("psk must be between 8 and 63 characters (WPA-PSK requirement)");
    }
  }
  // B5: NONE + psk is contradictory
  if (key_mgmt === "NONE" && psk !== undefined && psk.length > 0) {
    throw new Error("key_mgmt=NONE conflicts with psk being set");
  }
}

function validateCryptHash(s: string): string {
  // B7: only $6$ (SHA-512) or $y$ (yescrypt); end-anchored, length-capped, no newline/colon
  if (!RX_CRYPT_HASH.test(s)) {
    throw new Error("password_hash must be a $6$... (SHA-512) or $y$... (yescrypt) crypt hash (max 256 chars after prefix, no newline or ':')");
  }
  return s;
}

// B5: filter forbidden prefixes by platform so POSIX paths aren't checked on Windows and vice versa
const FORBIDDEN_TARGET_PREFIXES_NORMALIZED = process.platform === "win32"
  ? [
      "C:\\WINDOWS",
      "C:\\PROGRAM FILES",
      "C:\\PROGRAM FILES (X86)",
    ]
  : [
      "/ETC",
      "/USR",
      "/BOOT",
      "/HOME",
      "/ROOT",
    ];

function checkTargetDirPath(raw: string, dir: string): void {
  const upper = dir.toUpperCase();
  // refuse '/', 'C:\', '~'
  if (
    dir === sep ||
    /^[A-Z]:\\?$/i.test(dir) ||
    raw === "~" ||
    raw.startsWith("~/") ||
    raw.startsWith("~\\")
  ) {
    throw new Error(`target_dir '${raw}' refused (root or home shortcut). Set RPI_ALLOW_TARGET_DIR=1 to override.`);
  }
  for (const prefix of FORBIDDEN_TARGET_PREFIXES_NORMALIZED) {
    if (upper === prefix || upper.startsWith(prefix + sep) || upper.startsWith(prefix + "/")) {
      throw new Error(
        `target_dir '${raw}' is under a protected system path (${prefix}). Set RPI_ALLOW_TARGET_DIR=1 to override.`,
      );
    }
  }
  // For non-override, require the path to be on a removable device when we can detect it.
  const lbd = listBlockDevices();
  if (lbd.ok && lbd.platform === "win32") {
    // E:\ -> drive 'E'. We can't perfectly map drive-letter → disk index from Get-Disk
    // alone (would need Get-Partition); skip strict enforcement on win32 but warn-throw
    // if the path is on the system drive.
    const sysDrive = (process.env.SystemDrive ?? "C:").toUpperCase();
    if (upper.startsWith(sysDrive + "\\")) {
      throw new Error(
        `target_dir '${raw}' is on the system drive ${sysDrive}. Insert the SD card and pass its drive letter, or set RPI_ALLOW_TARGET_DIR=1.`,
      );
    }
  }
}

function validateTargetDir(raw: string): string {
  const dir = resolve(raw);

  if (process.env.RPI_ALLOW_TARGET_DIR === "1") {
    return dir;
  }

  checkTargetDirPath(raw, dir);

  // S4: dereference symlinks and re-check against the real path so a symlink
  // can't point an allowed-looking path at a forbidden system location.
  let real: string | null = null;
  try {
    real = realpathSync(dir);
  } catch (e) {
    // ENOENT is fine — directory will be created. Other errors propagate.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (real && real !== dir) {
    // B2: pass real for both display and check so error messages show the resolved path
    checkTargetDirPath(real, real);
  }
  return dir;
}

// ===========================================================================
// helpers
// ===========================================================================

function textContent(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

// B14: surface JSON parse errors instead of swallowing.
function coerceObject<T>(val: unknown): T | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch (e) {
      throw new Error(`expected object or JSON-encoded object, got invalid JSON: ${(e as Error).message}`);
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    throw new Error("expected JSON object, got non-object value");
  }
  if (typeof val === "object" && !Array.isArray(val)) return val as T;
  throw new Error("expected object value");
}

function coerceArray<T>(val: unknown): T[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(val);
    } catch (e) {
      throw new Error(`expected array or JSON-encoded array, got invalid JSON: ${(e as Error).message}`);
    }
    if (Array.isArray(parsed)) return parsed as T[];
    throw new Error("expected JSON array, got non-array value");
  }
  if (Array.isArray(val)) return val as T[];
  throw new Error("expected array value");
}

// ===========================================================================
// File generators
// ===========================================================================

type ExtraNetwork = {
  ssid: string;
  psk?: string;
  key_mgmt?: "WPA-PSK" | "NONE";
  priority?: number;
  scan_ssid?: boolean;
  country?: string;
};

function wpaSupplicant(p: {
  ssid: string;
  psk?: string;
  key_mgmt?: "WPA-PSK" | "NONE";
  country: string;
  scan_ssid?: boolean;
  priority?: number;
  extra_networks?: ExtraNetwork[];
}): string {
  validateCountry(p.country);
  validateSsidPsk(p.ssid, p.psk, p.key_mgmt);
  const networks: string[] = [];
  const build = (n: {
    ssid: string;
    psk?: string;
    key_mgmt?: string;
    priority?: number;
    scan_ssid?: boolean;
  }) => {
    const lines: string[] = ["network={"];
    lines.push(`    ssid="${n.ssid.replace(/"/g, '\\"')}"`);
    const km = n.key_mgmt ?? (n.psk ? "WPA-PSK" : "NONE");
    if (km === "WPA-PSK") {
      if (!n.psk) throw new Error("WPA-PSK requires psk");
      lines.push(`    psk="${n.psk.replace(/"/g, '\\"')}"`);
      lines.push(`    key_mgmt=WPA-PSK`);
    } else {
      lines.push(`    key_mgmt=NONE`);
    }
    if (n.priority !== undefined) lines.push(`    priority=${n.priority}`);
    if (n.scan_ssid) lines.push(`    scan_ssid=1`);
    lines.push("}");
    return lines.join("\n");
  };
  networks.push(build({ ...p }));
  // B6: validate and honor scan_ssid / country in extras
  for (const n of p.extra_networks ?? []) {
    validateSsidPsk(n.ssid, n.psk, n.key_mgmt);
    if (n.country) validateCountry(n.country);
    networks.push(build(n));
  }
  return [
    `country=${p.country.toUpperCase()}`,
    `ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev`,
    `update_config=1`,
    "",
    ...networks,
    "",
  ].join("\n");
}

function hasOpenssl(): { path: string } | null {
  const r = spawnSync("openssl", ["version"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  // B1: r.error covers ENOENT / timeout etc. before checking status.
  if (!r.error && r.status === 0) return { path: "openssl" };
  return null;
}

function opensslPasswdSha512(password: string): { hash: string } | { error: string } {
  if (!hasOpenssl()) {
    return {
      error:
        "openssl not found on PATH. Install openssl or pass password_hash directly. Manual command: openssl passwd -6 '<password>'",
    };
  }
  // B2: openssl reads the first line from stdin; CR/LF in the password would silently
  // truncate the hashed input. Reject loudly instead.
  if (/[\n\r]/.test(password)) {
    return { error: "password must not contain newline or carriage-return characters" };
  }
  const r = spawnSync("openssl", ["passwd", "-6", "-stdin"], {
    input: password,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  // B1+B3: r.error covers spawn failure / timeout; r.stderr/stdout may be undefined.
  if (r.error || r.status !== 0) {
    const detail = r.stderr?.trim() || r.stdout?.trim() || r.error?.message || "unknown error";
    return { error: `openssl passwd failed: ${detail}` };
  }
  const hash = r.stdout.trim();
  if (!hash.startsWith("$6$")) return { error: `unexpected openssl output: ${hash}` };
  return { hash };
}

function userconf(p: { username: string; password_hash: string }): string {
  validateUsername(p.username);
  validateCryptHash(p.password_hash);
  return `${p.username}:${p.password_hash}\n`;
}

function firstrunSh(p: {
  hostname?: string;
  locale?: string;
  timezone?: string;
  ssh_pubkey?: string;
  username?: string;
  sudo_nopasswd?: boolean;
  commands?: string[];
}): string {
  if (p.hostname) validateHostname(p.hostname);
  if (p.timezone) validateTimezone(p.timezone);
  if (p.locale) validateLocale(p.locale);
  if (p.ssh_pubkey) validateSshPubkey(p.ssh_pubkey);
  if (p.username) validateUsername(p.username);
  if (p.commands) validateCommands(p.commands);

  const lines: string[] = [
    "#!/bin/bash",
    "# auto-generated by raspberry-pi-setup-mcp",
    "set -e",
    "",
  ];
  if (p.hostname) {
    // S1: single-quote shell args (hostname/timezone/locale validated to safe chars above,
    // but quoting is defence-in-depth and documents intent)
    lines.push(`hostnamectl set-hostname '${p.hostname}'`);
    // S11: delete any existing 127.0.1.1 line first, then append.
    lines.push(`sed -i '/^127\\.0\\.1\\.1\\b/d' /etc/hosts`);
    lines.push(`printf '127.0.1.1 %s\\n' '${p.hostname}' >> /etc/hosts`);
  }
  if (p.timezone) lines.push(`timedatectl set-timezone '${p.timezone}'`);
  if (p.locale) lines.push(`localectl set-locale 'LANG=${p.locale}'`);
  if (p.ssh_pubkey && p.username) {
    lines.push(`mkdir -p /home/${p.username}/.ssh`);
    // S8/S6: heredoc instead of echo "..."; use a unique marker to avoid theoretical collision.
    lines.push(`cat <<'AUTHORIZED_EOF' >> /home/${p.username}/.ssh/authorized_keys`);
    lines.push(p.ssh_pubkey);
    lines.push(`AUTHORIZED_EOF`);
    lines.push(`chown -R ${p.username}:${p.username} /home/${p.username}/.ssh`);
    lines.push(`chmod 700 /home/${p.username}/.ssh`);
    lines.push(`chmod 600 /home/${p.username}/.ssh/authorized_keys`);
  }
  // C1: sudo_nopasswd — applied only when firstrun.sh is already being written
  if (p.sudo_nopasswd && p.username) {
    lines.push(`echo '${p.username} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/010_${p.username}_nopasswd`);
    lines.push(`chmod 440 /etc/sudoers.d/010_${p.username}_nopasswd`);
  }
  if (p.commands) {
    for (const c of p.commands) lines.push(c);
  }
  // B17: Bookworm mounts /boot/firmware ro by default; remount rw before sed/rm.
  lines.push("mount -o remount,rw /boot/firmware 2>/dev/null || true");
  lines.push("rm -f /boot/firmware/firstrun.sh /boot/firstrun.sh");
  lines.push(
    `sed -i 's| systemd.run.*||g' /boot/firmware/cmdline.txt 2>/dev/null || sed -i 's| systemd.run.*||g' /boot/cmdline.txt 2>/dev/null || true`,
  );
  lines.push("exit 0");
  return lines.join("\n") + "\n";
}

type PrepareBootInput = {
  target_dir: string;
  wifi?: {
    ssid: string;
    psk?: string;
    country: string;
    key_mgmt?: "WPA-PSK" | "NONE";
    scan_ssid?: boolean;
    priority?: number;
  };
  enable_ssh?: boolean;
  user?: { username: string; password?: string; password_hash?: string; sudo_nopasswd?: boolean };
  hostname?: string;
  locale?: string;
  timezone?: string;
  ssh_pubkey?: string;
  firstrun_commands?: string[];
};

function prepareBoot(p: PrepareBootInput) {
  const dir = validateTargetDir(p.target_dir);
  // C2: ssh_pubkey is silently dropped in firstrunSh unless username is set; surface this.
  if (p.ssh_pubkey && !p.user?.username) {
    throw new Error("prepare_boot.ssh_pubkey requires 'user.username' (authorized_keys is written to /home/<username>/.ssh)");
  }
  const errors: string[] = [];

  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  if (p.wifi) {
    const path = join(dir, "wpa_supplicant.conf");
    writeFileSync(
      path,
      wpaSupplicant({
        ssid: p.wifi.ssid,
        psk: p.wifi.psk,
        country: p.wifi.country,
        key_mgmt: p.wifi.key_mgmt,
        scan_ssid: p.wifi.scan_ssid,
        priority: p.wifi.priority,
      }),
      "utf8",
    );
    written.push(path);
  }
  if (p.enable_ssh) {
    const path = join(dir, "ssh");
    writeFileSync(path, "", "utf8");
    written.push(path);
  }
  if (p.user) {
    // U3: validate password requirements at the case branch.
    if (!p.user.password_hash && !p.user.password) {
      throw new Error("prepare_boot.user requires either 'password' or 'password_hash'");
    }
    let hash = p.user.password_hash;
    if (!hash) {
      const h = opensslPasswdSha512(p.user.password!);
      if ("error" in h) {
        // B8: surface as top-level errors
        errors.push(h.error);
      } else {
        hash = h.hash;
      }
    }
    if (hash) {
      const path = join(dir, "userconf.txt");
      writeFileSync(path, userconf({ username: p.user.username, password_hash: hash }), "utf8");
      written.push(path);
    }
  }
  if (p.hostname || p.timezone || p.locale || p.ssh_pubkey || p.firstrun_commands?.length || p.user?.sudo_nopasswd) {
    const path = join(dir, "firstrun.sh");
    writeFileSync(
      path,
      firstrunSh({
        hostname: p.hostname,
        timezone: p.timezone,
        locale: p.locale,
        ssh_pubkey: p.ssh_pubkey,
        username: p.user?.username,
        sudo_nopasswd: p.user?.sudo_nopasswd,
        commands: p.firstrun_commands,
      }),
      "utf8",
    );
    written.push(path);
  }
  const result: Record<string, unknown> = {
    target_dir: dir,
    written,
    notes: [
      "Copy these files to the root of the SD card's boot partition (labelled 'bootfs' on Raspberry Pi OS). / これらのファイルを SD カードの boot パーティション（Raspberry Pi OS の場合は 'bootfs'）の直下にコピーしてください。",
      "To use firstrun.sh, append to the end of cmdline.txt (same line, no newline): systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target / firstrun.sh を使うには、cmdline.txt の末尾（同一行）に上記を追記してください。",
      "See README section 'firstrun.sh を有効化する' for details.",
    ],
  };
  if (errors.length) {
    result.errors = errors;
  }
  return { result, hadErrors: errors.length > 0 };
}

type Checks = Record<string, { ok?: boolean; note?: string; path?: string; version?: string } | string>;

function checkRequirements(): Checks {
  const checks: Checks = {};
  checks.openssl = hasOpenssl()
    ? { ok: true }
    : { ok: false, note: "password hashing needs openssl or pre-hashed password" };
  const rpi = spawnSync(process.platform === "win32" ? "where" : "which", ["rpi-imager"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  checks.rpi_imager =
    !rpi.error && rpi.status === 0
      ? { ok: true, path: rpi.stdout.trim().split(/\r?\n/)[0] }
      : { ok: false, note: "install from https://www.raspberrypi.com/software/" };
  const node = spawnSync("node", ["-v"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  checks.node = { version: !node.error ? node.stdout.trim() : "unavailable" };
  checks.platform = process.platform;
  checks.arch = process.arch;
  return checks;
}

// ===========================================================================
// Server
// ===========================================================================

const server = new McpServer({ name: "raspberry-pi-setup", version: PKG.version });

server.tool(
  "rpi_setup",
  `Raspberry Pi の初期セットアップを支援する。OS 選定の相談から、ヘッドレス起動に必要なファイル (wpa_supplicant.conf / userconf.txt / ssh / firstrun.sh) の生成までを対話的にやる前提。

Actions:
- list_os: カタログ全件を返す。good_for タグ付き。
- recommend_os: use_case (日本語可) と experience (beginner/intermediate/advanced) を渡すと、スコアリングして上位 5 件を返す。
- generate_wpa_supplicant: WiFi 設定ファイル本文を生成。ssid / psk / country 必須。extra_networks で複数 SSID も。
- generate_userconf: Pi OS Bookworm 以降の userconf.txt (username:crypt_hash) を生成。password_hash が必要（password を渡せば openssl で生成、なければ手動で生成するコマンドを返す）。
- generate_firstrun: 初回起動時に実行される firstrun.sh を生成（ホスト名 / ロケール / TZ / SSH 公開鍵配置 / 追加コマンド）。
- enable_ssh_instructions: ssh ファイルの作り方・場所の説明を返す。
- prepare_boot: target_dir に wpa_supplicant.conf / userconf.txt / ssh / firstrun.sh をまとめて書き出す。SD カードの boot パーティションを直接指定する想定。
- hash_password: password を SHA-512 crypt ($6$...) に変換。openssl 依存。
- check_requirements: 環境チェック（openssl / rpi-imager / Node / platform / arch）。
- cloud_init_ubuntu: Ubuntu Server Pi 用 user-data YAML を生成。
- dietpi_config: DietPi 固有の dietpi.txt + dietpi-wifi.txt を生成。dietpi.headless は省略時 1 (ヘッドレス・自動セットアップ) がデフォルト、明示的に false を渡した場合のみ 0 になる。
- list_block_devices: ブロックデバイス一覧（プラットフォーム別）。
- generate_ssh_keypair: ed25519 SSH キーペアを Node 内で生成し、秘密鍵を private_key_path に mode 0600 で保存。公開鍵は同じディレクトリの <private_key_path>.pub にも書き出される。

セキュリティモデル: 入力は最終的に Pi 上で root 実行されるので、hostname / username / timezone / locale / country / ssh_pubkey / commands に厳格な検証をかけている。target_dir も既定でシステム領域を拒否（RPI_ALLOW_TARGET_DIR=1 でバイパス可）。`,
  {
    action: z
      .enum([
        "list_os",
        "recommend_os",
        "generate_wpa_supplicant",
        "generate_userconf",
        "generate_firstrun",
        "enable_ssh_instructions",
        "prepare_boot",
        "hash_password",
        "check_requirements",
        "cloud_init_ubuntu",
        "dietpi_config",
        "list_block_devices",
        "generate_ssh_keypair",
      ])
      .describe("Action to run. See tool description for the full action list."),
    use_case: z.string().optional().describe("recommend_os: 用途 (例: 'プログラミング学習', 'web server', 'レトロゲーム')"),
    experience: z.enum(["beginner", "intermediate", "advanced"]).optional().describe("recommend_os: 経験レベル"),
    ssid: z.string().optional().describe("wpa_supplicant: WiFi SSID"),
    psk: z.string().optional().describe("wpa_supplicant: WiFi パスワード (WPA-PSK, 8-63 chars)"),
    country: z.string().optional().describe("wpa_supplicant: ISO 3166-1 alpha-2 国コード (例: 'JP', 'US')"),
    key_mgmt: z.enum(["WPA-PSK", "NONE"]).optional().describe("wpa_supplicant: 認証方式 — WPA-PSK (password-protected) / NONE (open network, no encryption)"),
    scan_ssid: z.boolean().optional().describe("wpa_supplicant: 非公開 SSID 対応"),
    extra_networks: z
      .union([
        z.array(
          z.object({
            ssid: z.string().describe("SSID"),
            psk: z.string().optional().describe("WPA-PSK passphrase (8-63 chars)"),
            key_mgmt: z.enum(["WPA-PSK", "NONE"]).optional().describe("auth mode"),
            priority: z.number().optional().describe("higher = preferred"),
            scan_ssid: z.boolean().optional().describe("hidden SSID flag"),
            country: z.string().optional().describe("ISO 3166-1 alpha-2 (per-network override)"),
          }),
        ),
        z.string(),
      ])
      .optional()
      .describe("wpa_supplicant: 複数 SSID を設定"),
    username: z.string().optional().describe("userconf: username"),
    password: z.string().optional().describe("userconf/hash_password: 平文 (openssl で hash 化)"),
    password_hash: z.string().optional().describe("userconf: crypt(3) hash ($6$... / $y$...)"),
    hostname: z.string().optional().describe("firstrun/prepare_boot: hostname"),
    locale: z.string().optional().describe("firstrun/prepare_boot: locale (例: 'ja_JP.UTF-8')"),
    timezone: z.string().optional().describe("firstrun/prepare_boot: timezone (例: 'Asia/Tokyo')"),
    ssh_pubkey: z.string().optional().describe("firstrun/prepare_boot: SSH 公開鍵 (authorized_keys に追加)"),
    firstrun_commands: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("firstrun: 追加で実行する bash コマンド列（一行 1 コマンド、改行不可）"),
    target_dir: z.string().optional().describe("prepare_boot: 書き出し先ディレクトリ (SD の boot パーティションを指定, e.g. 'E:/' on Windows, '/media/user/bootfs' on Linux)"),
    enable_ssh: z.boolean().optional().describe("prepare_boot: 'ssh' 空ファイルを作る (SSH 有効化)"),
    wifi: z
      .union([
        z.object({
          ssid: z.string(),
          psk: z.string().optional(),
          country: z.string(),
          key_mgmt: z.enum(["WPA-PSK", "NONE"]).optional(),
          scan_ssid: z.boolean().optional(),
          priority: z.number().optional(),
        }),
        z.string(),
      ])
      .optional()
      .describe("prepare_boot: WiFi 設定"),
    user: z
      .union([
        z.object({
          username: z.string(),
          password: z.string().optional(),
          password_hash: z.string().optional(),
          sudo_nopasswd: z.boolean().optional(),
        }),
        z.string(),
      ])
      .optional()
      .describe("prepare_boot / cloud_init_ubuntu: 初期ユーザー"),
    packages: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("cloud_init_ubuntu: apt パッケージ一覧"),
    runcmd: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("cloud_init_ubuntu: runcmd に追加する shell 行"),
    dietpi: z
      .union([
        z.object({
          password: z.string().optional(),
          password_hash: z.string().optional(),
          autostart: z.string().optional(),
          ssh_server: z.boolean().optional(),
          keyboard_layout: z.string().optional(),
          // U6: default true = AUTO_SETUP_HEADLESS=1 (headless/automated setup)
          headless: z.boolean().default(true),
        }),
        z.string(),
      ])
      .optional()
      .describe("dietpi_config: DietPi 固有オプション"),
    ssh_key_type: z.enum(["ed25519", "rsa", "ecdsa"]).optional().describe("generate_ssh_keypair: 鍵種別 (現状 ed25519 のみサポート)"),
    ssh_key_bits: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("generate_ssh_keypair: ed25519 は固定長のため bits は無意味。値を渡すとエラーになる (ed25519 only supported)"),
    ssh_key_passphrase: z
      .string()
      .optional()
      .describe("generate_ssh_keypair: 暗号化パスフレーズ。現状の in-process 生成器 (ed25519) ではパスフレーズ暗号化を実装していないため、値を渡すと拒否される。暗号化が必要なら手動で ssh-keygen を使う事。"),
    ssh_key_comment: z
      .string()
      .optional()
      .describe("generate_ssh_keypair: コメント (例: 'pi-home@mymachine')"),
    private_key_path: z
      .string()
      .optional()
      .describe("generate_ssh_keypair: 秘密鍵の保存先 (mode 0600 で書き出す)。秘密鍵自体はレスポンスに含めない。"),
  },
  async (raw) => {
    try {
      // object/array 引数が JSON 文字列化されて届くケースを吸収する
      const p = {
        ...raw,
        extra_networks: coerceArray<ExtraNetwork>(raw.extra_networks),
        firstrun_commands: coerceArray<string>(raw.firstrun_commands),
        wifi: coerceObject<{
          ssid: string;
          psk?: string;
          country: string;
          key_mgmt?: "WPA-PSK" | "NONE";
          scan_ssid?: boolean;
          priority?: number;
        }>(raw.wifi),
        user: coerceObject<{
          username: string;
          password?: string;
          password_hash?: string;
          sudo_nopasswd?: boolean;
        }>(raw.user),
        packages: coerceArray<string>(raw.packages),
        runcmd: coerceArray<string>(raw.runcmd),
        dietpi: coerceObject<{
          password?: string;
          password_hash?: string;
          autostart?: string;
          ssh_server?: boolean;
          keyboard_layout?: string;
          headless?: boolean;
        }>(raw.dietpi),
      };
      switch (p.action) {
        case "list_os":
          return textContent({ count: OS_CATALOG.length, os: OS_CATALOG });
        case "recommend_os": {
          if (!p.use_case) return errContent("recommend_os requires 'use_case'");
          const recs = recommendOs(p.use_case, p.experience ?? "beginner");
          return textContent({
            use_case: p.use_case,
            experience: p.experience ?? "beginner",
            count: recs.length,
            recommendations: recs,
          });
        }
        case "generate_wpa_supplicant": {
          if (!p.ssid || !p.country) return errContent("wpa_supplicant requires 'ssid' and 'country'");
          const content = wpaSupplicant({
            ssid: p.ssid,
            psk: p.psk,
            country: p.country,
            key_mgmt: p.key_mgmt,
            scan_ssid: p.scan_ssid,
            extra_networks: p.extra_networks,
          });
          return textContent({ filename: "wpa_supplicant.conf", content });
        }
        case "generate_userconf": {
          if (!p.username) return errContent("userconf requires 'username'");
          // U3: validate at the case branch
          if (!p.password_hash && !p.password) {
            return errContent("userconf requires 'password' or 'password_hash'");
          }
          let hash = p.password_hash;
          if (!hash) {
            const h = opensslPasswdSha512(p.password!);
            if ("error" in h) return errContent(h.error);
            hash = h.hash;
          }
          const content = userconf({ username: p.username, password_hash: hash });
          return textContent({ filename: "userconf.txt", content });
        }
        case "generate_firstrun": {
          const content = firstrunSh({
            hostname: p.hostname,
            timezone: p.timezone,
            locale: p.locale,
            ssh_pubkey: p.ssh_pubkey,
            username: p.username,
            commands: p.firstrun_commands,
          });
          return textContent({
            filename: "firstrun.sh",
            content,
            note:
              "cmdline.txt の末尾にも 'systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target' を追加する必要がある",
          });
        }
        case "enable_ssh_instructions":
          return textContent({
            summary:
              "SD カードの boot パーティション直下に 'ssh' という空ファイル（拡張子なし）を置くだけで SSH が有効化される。",
            filename: "ssh",
            content: "",
            note:
              "Bookworm 以降は userconf.txt でパスワード設定したユーザーが必要。古い Pi OS ならデフォルト pi:raspberry でログイン可（非推奨）。",
          });
        case "prepare_boot": {
          if (!p.target_dir) return errContent("prepare_boot requires 'target_dir'");
          const out = prepareBoot({
            target_dir: p.target_dir,
            wifi: p.wifi,
            enable_ssh: p.enable_ssh,
            user: p.user,
            hostname: p.hostname,
            locale: p.locale,
            timezone: p.timezone,
            ssh_pubkey: p.ssh_pubkey,
            firstrun_commands: p.firstrun_commands,
          });
          // B8: surface errors as top-level + isError when present
          if (out.hadErrors) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(out.result, null, 2) }],
              isError: true,
            };
          }
          return textContent(out.result);
        }
        case "hash_password": {
          if (!p.password) return errContent("hash_password requires 'password'");
          const h = opensslPasswdSha512(p.password);
          if ("error" in h) return errContent(h.error);
          return textContent({ hash: h.hash, format: "SHA-512 crypt ($6$)" });
        }
        case "check_requirements":
          return textContent(checkRequirements());
        case "cloud_init_ubuntu": {
          if (!p.user) return errContent("cloud_init_ubuntu requires 'user'");
          // U3: validate password requirements at branch
          if (!p.user.password_hash && !p.user.password) {
            return errContent("cloud_init_ubuntu user requires 'password' or 'password_hash'");
          }
          // Validate all fields that end up in the generated YAML
          validateUsername(p.user.username);
          if (p.hostname) validateHostname(p.hostname);
          if (p.timezone) validateTimezone(p.timezone);
          if (p.locale) validateLocale(p.locale);
          if (p.ssh_pubkey) validateSshPubkey(p.ssh_pubkey);
          if (p.user.password_hash) validateCryptHash(p.user.password_hash);
          if (p.packages) validatePackages(p.packages);
          if (p.runcmd) validateCommands(p.runcmd);
          if (p.wifi?.ssid) validateSsidPsk(p.wifi.ssid, p.wifi.psk);
          if (p.wifi?.country) validateCountry(p.wifi.country);
          // S10: always emit password_hash, never plain_text
          let password_hash = p.user.password_hash;
          if (!password_hash) {
            const h = opensslPasswdSha512(p.user.password!);
            if ("error" in h) return errContent(h.error);
            password_hash = h.hash;
          }
          const yaml = cloudInitYaml({
            hostname: p.hostname,
            timezone: p.timezone,
            locale: p.locale,
            user: {
              username: p.user.username,
              password_hash,
              sudo_nopasswd: p.user.sudo_nopasswd, // S9: default false (only true emits NOPASSWD)
            },
            ssh_pubkey: p.ssh_pubkey,
            wifi: p.wifi,
            packages: p.packages,
            runcmd: p.runcmd,
          });
          // S5: don't return password_hash in the response
          return textContent({
            filename: "user-data",
            content: yaml,
            note:
              "Place as 'user-data' on the system-boot partition of Ubuntu Server Pi. Pair with empty 'meta-data' file.",
          });
        }
        case "dietpi_config": {
          // S4: refuse without explicit password / password_hash
          if (!p.dietpi || (!p.dietpi.password && !p.dietpi.password_hash)) {
            return errContent("dietpi_config requires 'dietpi.password' or 'dietpi.password_hash'");
          }
          if (p.hostname) validateHostname(p.hostname);
          if (p.timezone) validateTimezone(p.timezone);
          if (p.locale) validateLocale(p.locale);
          if (p.dietpi.password_hash) validateCryptHash(p.dietpi.password_hash);
          if (p.dietpi.keyboard_layout) validateSimpleToken("keyboard_layout", p.dietpi.keyboard_layout);
          if (p.dietpi.autostart !== undefined) validateSimpleToken("autostart", String(p.dietpi.autostart));
          if (p.wifi?.ssid) validateSsidPsk(p.wifi.ssid, p.wifi.psk);
          if (p.wifi?.country) validateCountry(p.wifi.country);
          let password_hash = p.dietpi.password_hash;
          if (!password_hash && p.dietpi.password) {
            const h = opensslPasswdSha512(p.dietpi.password);
            if ("error" in h) return errContent(h.error);
            password_hash = h.hash;
          }
          const txt = dietpiTxt({
            password_hash,
            hostname: p.hostname,
            timezone: p.timezone,
            locale: p.locale,
            keyboard_layout: p.dietpi.keyboard_layout,
            headless: p.dietpi.headless,
            ssh_server: p.dietpi.ssh_server,
            autostart: p.dietpi.autostart,
            wifi: p.wifi,
          });
          const out: Record<string, { content: string }> = { "dietpi.txt": { content: txt } };
          if (p.wifi) {
            out["dietpi-wifi.txt"] = {
              content: dietpiWifiTxt({ ssid: p.wifi.ssid, psk: p.wifi.psk, key_mgmt: p.wifi.key_mgmt }),
            };
          }
          return textContent({
            files: out,
            note: "Place on the DietPi boot partition. If wifi is set, both dietpi.txt and dietpi-wifi.txt are generated.",
          });
        }
        case "list_block_devices":
          return textContent(listBlockDevices());
        case "generate_ssh_keypair": {
          if (!p.private_key_path) {
            return errContent("generate_ssh_keypair requires 'private_key_path' (秘密鍵の保存先).");
          }
          const r = generateSshKeypair({
            comment: p.ssh_key_comment,
            passphrase: p.ssh_key_passphrase,
            type: p.ssh_key_type,
            bits: p.ssh_key_bits,
            private_key_path: p.private_key_path,
          });
          return textContent(r);
        }
        default: {
          // B24 / U7: exhaustive switch
          const _exhaustive: never = p.action;
          return errContent(`unknown action: ${String(_exhaustive)}`);
        }
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return errContent(`${e?.name ?? "Error"}: ${e?.message ?? String(err)}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
