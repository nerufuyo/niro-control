#!/bin/bash
# Makes the key that signs Niro Control's packages and dnf repository, in your own gpg keyring (it never leaves this computer).
# usage: scripts/make-signing-key.sh      then:  NIRO_GPG_KEY=<the id it prints> NOTES="..." scripts/release.sh
# Needs rpm-sign (dnf install rpm-sign) to sign the package. Back the key up (gpg --export-secret-keys --armor <id>) somewhere safe:
# without it a later release cannot be signed and every computer that trusts this key stops accepting updates.
set -euo pipefail
NAME="Niro Control releases"
EMAIL=${1:-$(git config user.email)}
gpg --quick-generate-key "$NAME <$EMAIL>" ed25519 sign never
echo
gpg --list-secret-keys --keyid-format long "$EMAIL"
echo
echo "Use it as: NIRO_GPG_KEY=\"$EMAIL\" scripts/release.sh"
