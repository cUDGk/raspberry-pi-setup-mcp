export type PiOs = {
  id: string;
  name: string;
  description: string;
  base: "debian" | "arch" | "ubuntu" | "alpine" | "other";
  desktop: boolean;
  image_url?: string;
  default_user?: string;
  supports_userconf: boolean;
  good_for: string[];
  boot_partition_name: string;
  notes?: string;
};

export const OS_CATALOG: PiOs[] = [
  {
    id: "raspios-bookworm-64",
    name: "Raspberry Pi OS (Bookworm, 64-bit, Desktop)",
    description: "公式ディストリ。GUI 付きで一番標準的。Python/Scratch/LibreOffice 等の学習用ツールがプリイン。",
    base: "debian",
    desktop: true,
    image_url: "https://downloads.raspberrypi.com/raspios_full_arm64/images/",
    default_user: "pi",
    supports_userconf: true,
    good_for: ["general", "desktop", "学習", "kids_learning", "python", "scratch"],
    boot_partition_name: "bootfs",
  },
  {
    id: "raspios-bookworm-64-lite",
    name: "Raspberry Pi OS Lite (Bookworm, 64-bit)",
    description: "GUI なしの軽量版。サーバー用途・ヘッドレス前提。",
    base: "debian",
    desktop: false,
    image_url: "https://downloads.raspberrypi.com/raspios_lite_arm64/images/",
    default_user: "pi",
    supports_userconf: true,
    good_for: ["server", "headless", "homelab", "iot", "robotics", "docker"],
    boot_partition_name: "bootfs",
  },
  {
    id: "ubuntu-server-24-arm64",
    name: "Ubuntu Server 24.04 LTS (arm64)",
    description: "Ubuntu の LTS。snap/apt のエコシステム、Docker/k8s 等で実績が厚い。",
    base: "ubuntu",
    desktop: false,
    image_url: "https://ubuntu.com/download/raspberry-pi",
    default_user: "ubuntu",
    supports_userconf: false,
    good_for: ["server", "homelab", "k8s", "docker", "dev"],
    boot_partition_name: "system-boot",
    notes: "ヘッドレス設定は cloud-init (user-data/network-config) で行う。",
  },
  {
    id: "libreelec",
    name: "LibreELEC (Kodi)",
    description: "Kodi メディアセンター専用の最小 OS。リビング TV に繋いで動画再生用。",
    base: "other",
    desktop: true,
    image_url: "https://libreelec.tv/downloads/",
    supports_userconf: false,
    good_for: ["media_center", "kodi", "home_theater"],
    boot_partition_name: "",
    notes: "GUI セットアップで WiFi/SSH 設定する前提。ヘッドレス boot file は非対応。",
  },
  {
    id: "retropie",
    name: "RetroPie",
    description: "Raspberry Pi OS Lite ベースのレトロゲーム OS（ファミコン/ゲームボーイ等のエミュレータ）。",
    base: "debian",
    desktop: false,
    image_url: "https://retropie.org.uk/download/",
    default_user: "pi",
    supports_userconf: true,
    good_for: ["retro_gaming", "kids_learning", "fun"],
    boot_partition_name: "boot",
  },
  {
    id: "home-assistant-os",
    name: "Home Assistant OS",
    description: "スマートホームのハブ OS。完全なアプライアンス（他用途兼用不可）。",
    base: "other",
    desktop: false,
    image_url: "https://www.home-assistant.io/installation/raspberrypi/",
    supports_userconf: false,
    good_for: ["smart_home", "iot", "automation"],
    boot_partition_name: "",
  },
  {
    id: "dietpi",
    name: "DietPi",
    description: "Debian ベースの超軽量 OS。メモリ使用量が最小。Pi Zero 等の非力機に向く。",
    base: "debian",
    desktop: false,
    image_url: "https://dietpi.com/",
    default_user: "root",
    supports_userconf: false,
    good_for: ["headless", "server", "low_memory", "pi_zero"],
    boot_partition_name: "boot",
    notes: "dietpi.txt / dietpi-wifi.txt で設定する独自形式。",
  },
  {
    id: "alpine",
    name: "Alpine Linux (RPi edition)",
    description: "musl ベースの極小 OS。Docker ホスト・セキュリティ用途で人気。",
    base: "alpine",
    desktop: false,
    image_url: "https://alpinelinux.org/downloads/",
    default_user: "root",
    supports_userconf: false,
    good_for: ["docker", "server", "low_memory", "security"],
    boot_partition_name: "",
    notes: "diskless mode とハードディスクインストールを選べる。独自の setup-alpine スクリプトで初期設定。",
  },
];

export function recommendOs(useCase: string, experience: "beginner" | "intermediate" | "advanced" = "beginner"): PiOs[] {
  const lower = useCase.toLowerCase();
  const scored = OS_CATALOG.map((os) => {
    let score = 0;
    for (const tag of os.good_for) {
      if (lower.includes(tag.replace("_", " ")) || lower.includes(tag)) score += 10;
    }
    // keyword heuristics
    if (lower.match(/子ども|子供|子|learn|kid|child|school|scratch|python/) && os.good_for.includes("kids_learning")) score += 15;
    if (lower.match(/server|サーバ|ssh|docker|web/) && os.good_for.includes("server")) score += 10;
    if (lower.match(/game|レトロ|ファミコン|retro/) && os.good_for.includes("retro_gaming")) score += 15;
    if (lower.match(/media|tv|kodi|動画|映画|家で|family/) && os.good_for.includes("media_center")) score += 15;
    if (lower.match(/iot|robot|sensor|センサ|gpio/) && os.good_for.includes("iot")) score += 10;
    if (lower.match(/home|smart|alexa|google home/) && os.good_for.includes("smart_home")) score += 10;
    // experience bias
    if (experience === "beginner" && os.id === "raspios-bookworm-64") score += 20;
    if (experience === "beginner" && (os.id === "alpine" || os.id === "dietpi")) score -= 10;
    if (experience === "advanced" && os.id === "alpine") score += 5;
    return { os, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 5).map((s) => s.os);
}
