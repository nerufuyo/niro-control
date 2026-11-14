# Niro Control: `make` builds and tests everything; `make deb` makes the package; `make install` installs it.
.PHONY: all build test test-shell lint deb install clean catalog

all: test

build:
	npm run --silent build
	cargo build --release -p island-daemon

test:
	npm test
	cargo test -p island-core -p island-daemon

test-shell:           # needs the installed package and a built daemon; starts its own headless GNOME Shell
	tests/shell/headless.sh

lint:
	npm run --silent lint

catalog:
	python3 scripts/control-panel-items.py

deb:
	./packaging/build.sh

install: deb
	sudo dpkg -i $$(ls -t out/niro-control_*.deb | head -1)

clean:
	rm -rf out target shell/*/build shell/dock/dist control/build
