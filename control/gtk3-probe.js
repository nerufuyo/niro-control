// Asks GTK 3 itself whether its effective look is dark or light, instead of guessing from a theme's name: it reads the colours the
// theme (and the user's gtk-3.0/gtk.css) really give. Prints "dark", "light" or "unknown" (the colours disagree or could not be read).
// Run as a short-lived process by Niro's shell extension; it opens no window and writes nothing.
imports.gi.versions.Gtk = '3.0';
const {Gtk} = imports.gi;
const luminance = c => [c.red, c.green, c.blue].map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
try {
    if (!Gtk.init_check(null)[0]) { print('unknown'); imports.system.exit(0); }
    const ctx = new Gtk.Window().get_style_context();
    const look = name => { const [ok, c] = ctx.lookup_color(name); return ok ? c : null; };
    const bg = look('theme_bg_color') ?? look('bg_color'), fg = look('theme_fg_color') ?? look('fg_color');
    if (!bg || !fg) { print('unknown'); imports.system.exit(0); }
    const darkBg = luminance(bg) < 0.4, lightFg = luminance(fg) >= 0.4;
    // a dark theme has dark surfaces and light text; a light one the reverse; anything else is not trusted
    print(darkBg && lightFg ? 'dark' : !darkBg && !lightFg ? 'light' : 'unknown');
} catch (e) { print('unknown'); }
