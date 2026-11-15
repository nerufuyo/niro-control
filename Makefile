# Niro Control: `make` builds and tests everything; `make rpm` (Fedora) or `make deb` (Ubuntu/Debian) makes the package; `make install` installs it.
.PHONY: all build test test-shell test-installed test-dbus lint deb rpm install clean catalog deps

# Which package format this machine uses: rpm on Fedora and friends, deb on Debian and Ubuntu.
PKG := $(shell command -v dpkg-deb >/dev/null 2>&1 && echo deb || echo rpm)

all: test

build:
	npm run --silent build
	cargo build --release -p island-daemon

test:
	npm test
	cargo test -p island-core -p island-daemon

test-shell:           # a headless GNOME Shell against this checkout (needs the daemon built); no installed package required
	tests/shell/run-staged.sh

test-dbus:            # the island's D-Bus calls against the real daemon (needs it built)
	python3 scripts/check-dbus-interfaces.py

test-installed:       # the same against the installed package in /usr
	tests/shell/gtk3Probe.sh
	tests/shell/niroSync.sh
	tests/shell/appearance.sh
	tests/shell/headless.sh

lint:
	npm run --silent lint

catalog:
	python3 scripts/control-panel-items.py

deb:
	./packaging/build.sh

rpm:
	./packaging/build-rpm.sh

deps:                 # the build tools and libraries, from the distribution's own repositories
	./scripts/install-build-deps.sh

install: $(PKG)
ifeq ($(PKG),rpm)
	sudo dnf install -y $$(ls -t out/niro-control-*.rpm | head -1)
else
	sudo dpkg -i $$(ls -t out/niro-control_*.deb | head -1)
endif

clean:
	rm -rf out target shell/*/build shell/dock/dist control/build
