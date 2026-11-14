# Universal Appearance 2.0: performance, and why no comparison is claimed

Two runs of `scripts/benchmark-performance.sh --cold` exist for the same machine and method: `20261114-081644-c09f3f7` (before Universal Appearance, machine load average about 2 to 4 at start) and `20261114-112645-57f252d` (this sprint; load average 10 to 23 during and after the run: other processes on the machine, mostly `node`, were using most CPUs).

Everything in the second run is slower, including things Universal Appearance does not touch (profile apply 5.5 ms then, 13.9 ms now; panel start 503 ms then, 636 ms now; the real shell's idle CPU 2.7 % then, 9.8 % now; real shell PSS 367 MB then, 548 MB now, which is a different, longer-running process). That pattern is what a loaded machine looks like, not a regression in one component. **No improvement and no regression is claimed.** The comparable runs need an idle machine.

`scripts/benchmark-appearance.sh` (six windows, per variant) was run again; in both runs half of the variants did not complete because consecutive shells reused one Wayland display name (fixed in the script afterwards with a unique name per variant; not re-run because of the load). The variants that completed show 0.08 to 0.16 % shell CPU and no painted frames while idle, as before: nothing measurable at idle.

Not measured at all: frame timing during animation, window animation smoothness, GPU, battery, several monitors, fullscreen video, screen sharing, the effect of blur strength, application start-up impact.
