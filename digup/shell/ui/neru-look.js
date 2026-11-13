// The desktop-wide look (org.neru.desktop): the panel's opacity, accent and tint follow it, live.
(() => {
  const tauri = window.__TAURI__;
  if (!tauri) return;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const apply = (look) => {
    const root = document.documentElement.style;
    const [r, g, b] = rgb(look.tint);
    const [ar, ag, ab] = rgb(look.accent);
    root.setProperty("--neru-opacity", String(look.opacity / 100));
    root.setProperty("--neru-tint", `${r}, ${g}, ${b}`);
    root.setProperty("--accent", look.accent);
    root.setProperty("--ember", look.accent);
    root.setProperty("--amber", look.accent);
    root.setProperty("--selected", `rgba(${ar}, ${ag}, ${ab}, 0.28)`);
    root.setProperty("--mark", `rgba(${ar}, ${ag}, ${ab}, 0.38)`);
  };
  tauri.core.invoke("neru_look").then(apply).catch(() => {});
  tauri.event.listen("neru-look", ({ payload }) => apply(payload));
})();
