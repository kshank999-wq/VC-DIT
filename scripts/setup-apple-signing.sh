#!/bin/bash
# VC DIT: set up Mac code signing and notarization for the release builds.
#
# Run on the Mac that has your "Developer ID Application" certificate, by
# pasting this one line into Terminal:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/kshank999-wq/VC-DIT/HEAD/scripts/setup-apple-signing.sh)
#
# It finds the certificate in your login keychain, exports just that one
# certificate and its key (not your other identities), reads your Team ID,
# asks for your Apple ID and an app-specific password, and puts all five
# GitHub secrets in place: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
#
# With the GitHub CLI (`gh`, signed in) it uploads them itself; without it,
# it copies each value to the clipboard in turn and opens the secrets page
# for you to paste. Nothing is written outside a private temporary folder,
# which is deleted at the end.

set -euo pipefail

REPO="kshank999-wq/VC-DIT"
SECRETS_PAGE="https://github.com/$REPO/settings/secrets/actions"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '%s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "Run this on your Mac (the one with the Developer ID certificate)."

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bold "VC DIT · Mac signing setup"
say ""

# ---------------------------------------------------------------- 1. the certificate
identity="$(security find-identity -v -p codesigning | grep 'Developer ID Application' | head -1 || true)"
if [ -z "$identity" ]; then
  say "No \"Developer ID Application\" certificate was found in your keychain."
  say "Create one (you must be the Apple Developer account holder):"
  say "  developer.apple.com → Certificates → + → Developer ID Application"
  say "then double-click the downloaded file to install it, and run this again."
  open "https://developer.apple.com/account/resources/certificates/add" || true
  exit 1
fi
name="$(printf '%s' "$identity" | sed -E 's/.*"(Developer ID Application: [^"]+)".*/\1/')"
team_id="$(printf '%s' "$name" | sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/')"
[ "${#team_id}" -eq 10 ] || fail "Could not read the Team ID from: $name"
say "Found:   $name"
say "Team ID: $team_id"
say ""

# ---------------------------------------------------------------- 2. export just that identity
# `security export` can only export every identity at once (macOS may ask for
# your login password, or to allow access: click Allow). The bundle is then
# narrowed to the Developer ID certificate and its own key with openssl, and
# re-packed in the format the CI keychain imports reliably.
export_pass="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
export P="$export_pass"
say "Exporting the certificate (approve the keychain prompt if one appears)…"
security export -k "$HOME/Library/Keychains/login.keychain-db" -t identities -f pkcs12 -P "$P" -o "$WORK/all.p12" >/dev/null
openssl pkcs12 -in "$WORK/all.p12" -passin env:P -nodes -out "$WORK/all.pem" 2>/dev/null \
  || fail "Could not read the exported certificates."

# Each certificate and key in the PEM is preceded by its bag attributes,
# including a localKeyID shared by a certificate and its private key.
key_id="$(awk -v team="($team_id)" '
  /localKeyID:/ { id = $0; sub(/.*localKeyID: */, "", id) }
  /^subject=/ && index($0, "Developer ID Application") && index($0, team) { print id; exit }
' "$WORK/all.pem")"
[ -n "$key_id" ] || fail "Could not find the Developer ID certificate and its private key in the export. Is its private key on this Mac (a ▸ arrow next to it in Keychain Access)?"

awk -v want="$key_id" -v certout="$WORK/cert.pem" -v keyout="$WORK/key.pem" '
  /localKeyID:/ { id = $0; sub(/.*localKeyID: */, "", id) }
  /-----BEGIN CERTIFICATE-----/ { out = (id == want) ? certout : "" }
  /-----BEGIN (ENCRYPTED |RSA |EC )?PRIVATE KEY-----/ { out = (id == want) ? keyout : "" }
  out != "" { print > out }
  /-----END / { out = "" }
' "$WORK/all.pem"
[ -s "$WORK/cert.pem" ] && [ -s "$WORK/key.pem" ] || fail "Could not separate the Developer ID certificate from its key."

openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$name" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:P -out "$WORK/devid.p12" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$name" \
       -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -passout env:P -out "$WORK/devid.p12" 2>/dev/null \
  || fail "Could not package the certificate."
csc_link="$(base64 -i "$WORK/devid.p12" | tr -d '\r\n')"
say "Exported just the Developer ID certificate and its key."
say ""

# ---------------------------------------------------------------- 3. notarization login
say "Notarization needs your Apple ID and an app-specific password."
say "Make one at appleid.apple.com → Sign-In and Security → App-Specific Passwords (name it \"VC DIT GitHub\")."
read -r -p "Open that page now? [Y/n] " answer
case "${answer:-y}" in [Yy]*) open "https://account.apple.com/account/manage" || true ;; esac
read -r -p "Apple ID (email): " apple_id
read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx, hidden): " app_password
say ""
[ -n "$apple_id" ] && [ -n "$app_password" ] || fail "Both are needed."

if xcrun --find notarytool >/dev/null 2>&1; then
  say "Checking them with Apple…"
  if xcrun notarytool history --apple-id "$apple_id" --team-id "$team_id" --password "$app_password" >/dev/null 2>&1; then
    say "Apple accepted them."
  else
    fail "Apple refused that Apple ID, Team ID and app-specific password. Check them and run this again."
  fi
fi
say ""

# ---------------------------------------------------------------- 4. into GitHub
names=(CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
values=("$csc_link" "$export_pass" "$apple_id" "$app_password" "$team_id")

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  for i in "${!names[@]}"; do
    printf '%s' "${values[$i]}" | gh secret set "${names[$i]}" --repo "$REPO" >/dev/null
    say "Set ${names[$i]}"
  done
else
  say "The GitHub CLI isn't set up here, so we'll paste them in together (5 secrets)."
  say "For each one: on the page that opens, click \"New repository secret\", type the name"
  say "shown below, paste (⌘V) into Secret, click \"Add secret\", then come back here."
  open "$SECRETS_PAGE" || true
  for i in "${!names[@]}"; do
    printf '%s' "${values[$i]}" | pbcopy
    read -r -p "  $((i + 1))/5  Name: ${names[$i]}   (value copied) — press Enter when added " _
  done
  printf '' | pbcopy
fi

say ""
bold "Done. Mac builds of VC DIT will now be signed and notarized."
