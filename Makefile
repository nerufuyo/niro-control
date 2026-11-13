# Niro Control: `make` builds and tests everything; `make deb` makes the package; `make install` installs it.
.PHONY: all build test lint deb install clean

all: test

build:
	npm run --silent build
	cargo build --release -p island-daemon

test:
	npm test
	cargo test -p island-core -p island-daemon

lint:
	npm run --silent lint

deb:
	./packaging/build.sh

install: deb
	sudo dpkg -i $$(ls -t out/niro-control_*.deb | head -1)

clean:
	rm -rf out target shell/*/build shell/dock/dist control/build
