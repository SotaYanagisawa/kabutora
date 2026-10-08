/**
 * Browser and iOS status-bar color per app theme. It matches `--bg`, the color at the top of the
 * mobile layout, so a home-screen web app's status bar blends into the page and iOS picks dark or
 * light status text for contrast. The theme is the app's own setting, not the system scheme, so
 * the meta tag is written from script rather than with `media` queries.
 */
export const THEME_COLORS = { light: "#f4f4f3", dark: "#000000" } as const;

/**
 * The last applied theme, kept outside any account's preference namespace so the startup script
 * (which runs before sign-in) can paint the startup screen in it. Holds only "dark" or "light".
 */
export const BOOT_THEME_KEY = "kabutora-boot-theme";

export function applyThemeColor(theme: keyof typeof THEME_COLORS) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  if (meta.content !== THEME_COLORS[theme]) meta.content = THEME_COLORS[theme];
  try { window.localStorage.setItem(BOOT_THEME_KEY, theme); } catch { /* Storage is optional. */ }
}
