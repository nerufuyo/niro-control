# Window effects: cost (headless GNOME Shell, six GTK 4 windows, blur extension running)

`scripts/benchmark-appearance.sh` (REPS=2). AMD Ryzen 5 5600G, GNOME Shell 46, 25 s idle window per run. Variants: **legacy** (installed extension, whole-window fade 80%), **engine** (this repository's extension, no fade by default), **safe** (engine, safe mode), **none** (no blur extension).

| Variant | Runs | Shell CPU, idle | Frames painted while idle | PSS |
|---|---|---|---|---|
| legacy | 2 | 0.12 %, 0.08 % | 0, 0 | 176, 173 MB |
| engine | 1 valid (the other run's shell did not survive the test) | 0.08 % | 0 | 174 MB |
| safe | 2 | 0.12 %, 0.12 % | 0, 0 | 174, 175 MB |
| none | 1 valid (the other run's shell did not survive the test) | 0.04 % | 0 | 172 MB |

**Reading**: with a static desktop every variant is at the noise floor: no measurable CPU, no painted frames, memory within 4 MB. The new engine costs nothing measurable at idle; it also does not improve it, and nothing here says anything about animation or load.

**Not measured**: frame timing during animation or window drags, GPU load, battery, several monitors, fullscreen video, screen sharing, high-resolution displays, more than six windows. The two invalid runs were discarded, not retried.
