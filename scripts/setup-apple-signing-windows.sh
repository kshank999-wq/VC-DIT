#!/bin/bash
# VC DIT: set up Mac code signing and notarization from WINDOWS, using the
# files from creating the certificate there: the private key (.key) you made
# with OpenSSL and the Developer ID certificate(s) (.cer) Apple gave back.
#
# In Git Bash (it comes with Git for Windows), paste:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/kshank999-wq/VC-DIT/HEAD/scripts/setup-apple-signing-windows.sh) ~/vcgs-signing
#
# (the last part is the folder holding the .key and .cer files). It finds the
# certificate that belongs to your key, among however many copies there are,
# reads your Team ID from it, packages the two, and sets the GitHub secrets
# CSC_LINK, CSC_KEY_PASSWORD, APPLE_TEAM_ID, APPLE_ID and
# APPLE_APP_SPECIFIC_PASSWORD: by itself if the GitHub CLI (`gh`) is signed
# in, otherwise by copying each value to the clipboard while you paste it into
# the secrets page it opens. Nothing is written outside a private temporary
# folder, which is deleted at the end.

set -euo pipefail

REPO="kshank999-wq/VC-DIT"
SECRETS_PAGE="https://github.com/$REPO/settings/secrets/actions"
DIR="${1:-.}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '%s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
open_url() { (start "" "$1" || explorer.exe "$1" || xdg-open "$1" || open "$1") >/dev/null 2>&1 || true; }
copy() {
  if command -v clip >/dev/null 2>&1; then clip
  elif command -v pbcopy >/dev/null 2>&1; then pbcopy
  elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard
  else fail "No clipboard tool here: run this in Git Bash on Windows, or sign in the GitHub CLI (gh auth login) first."
  fi
}

command -v openssl >/dev/null 2>&1 || fail "OpenSSL isn't available. Run this in Git Bash (installed with Git for Windows)."
[ -d "$DIR" ] || fail "No folder \"$DIR\". Give the folder that holds your .key and .cer files."

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bold "VC DIT · Mac signing setup (from your certificate files)"
say "Looking in: $DIR"
say ""

# ---------------------------------------------------------------- 1. the private key(s)
keys=()
for f in "$DIR"/*.key "$DIR"/*.pem; do
  [ -f "$f" ] || continue
  if openssl pkey -in "$f" -noout 2>/dev/null; then keys+=("$f"); fi
done
[ "${#keys[@]}" -gt 0 ] || fail "No private key found (a .key or .pem file holding a PRIVATE KEY)."

# ---------------------------------------------------------------- 2. the certificate that matches one
# Every .cer/.crt/.pem in the folder, DER or PEM; keep the Developer ID
# Application ones whose public key is the private key's, and of those the
# one that expires last.
best_cert=""
best_key=""
best_end=0
n=0
for f in "$DIR"/*.cer "$DIR"/*.crt "$DIR"/*.pem; do
  [ -f "$f" ] || continue
  out="$WORK/c$n.pem"
  n=$((n + 1))
  openssl x509 -in "$f" -inform DER -out "$out" 2>/dev/null || openssl x509 -in "$f" -out "$out" 2>/dev/null || continue
  subject="$(openssl x509 -in "$out" -noout -subject 2>/dev/null)"
  case "$subject" in *"Developer ID Application"*) ;; *) continue ;; esac
  cert_pub="$(openssl x509 -in "$out" -noout -pubkey 2>/dev/null)"
  for k in "${keys[@]}"; do
    if [ "$cert_pub" = "$(openssl pkey -in "$k" -pubout 2>/dev/null)" ]; then
      end="$(openssl x509 -in "$out" -noout -enddate | cut -d= -f2)"
      end_s="$(date -d "$end" +%s 2>/dev/null || date -j -f '%b %e %T %Y %Z' "$end" +%s 2>/dev/null || echo 1)"
      say "Matches your key: $(basename "$f")   (expires $end)"
      if [ "$end_s" -gt "$best_end" ]; then best_end="$end_s"; best_cert="$out"; best_key="$k"; fi
    fi
  done
done
fp() { openssl sha256 | tail -c 13; }
if [ -z "$best_cert" ]; then
  # Show what was compared: public-key fingerprints only, nothing secret.
  say "Your private key(s):"
  for k in "${keys[@]}"; do say "  $(openssl pkey -in "$k" -pubout 2>/dev/null | fp)  $(basename "$k")"; done
  for f in "$DIR"/*.csr; do
    [ -f "$f" ] && say "  $(openssl req -in "$f" -noout -pubkey 2>/dev/null | fp)  $(basename "$f") (request)"
  done
  say "Certificates found:"
  for f in "$DIR"/*.cer "$DIR"/*.crt "$DIR"/*.pem; do
    [ -f "$f" ] || continue
    pem="$(openssl x509 -in "$f" -inform DER 2>/dev/null || openssl x509 -in "$f" 2>/dev/null || true)"
    [ -n "$pem" ] || continue
    kind="$(printf '%s' "$pem" | openssl x509 -noout -subject 2>/dev/null | sed -E 's/.*CN ?= ?([^,/]*).*/\1/' | cut -c1-34)"
    end="$(printf '%s' "$pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    say "  $(printf '%s' "$pem" | openssl x509 -noout -pubkey 2>/dev/null | fp)  $(basename "$f")  [$kind, expires $end]"
  done
  say ""
  say "None of the Developer ID certificates here belongs to your private key."
  say "Download the right one: developer.apple.com → Certificates → the Developer ID Application"
  say "made from your .csr → Download, put it in this folder, and run this again."
  open_url "https://developer.apple.com/account/resources/certificates/list"
  exit 1
fi
[ "$best_end" -gt "$(date +%s)" ] || fail "The matching certificate has expired. Create a new Developer ID Application certificate from the same .csr."

subject="$(openssl x509 -in "$best_cert" -noout -subject)"
name="$(printf '%s' "$subject" | sed -E 's/.*CN ?= ?(Developer ID Application: [^,/]*\([A-Z0-9]{10}\)).*/\1/')"
team_id="$(printf '%s' "$subject" | sed -E 's/.*\(([A-Z0-9]{10})\).*/\1/')"
[ "${#team_id}" -eq 10 ] || fail "Could not read the Team ID from: $subject"
say ""
say "Using:   $name"
say "Team ID: $team_id"
say ""

# ---------------------------------------------------------------- 3. package it
export_pass="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
export P="$export_pass"
openssl pkcs12 -export -inkey "$best_key" -in "$best_cert" -name "$name" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -passout env:P -out "$WORK/devid.p12" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$best_key" -in "$best_cert" -name "$name" \
       -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -passout env:P -out "$WORK/devid.p12" 2>/dev/null \
  || fail "Could not package the certificate and key."
csc_link="$(base64 < "$WORK/devid.p12" | tr -d '\r\n')"
say "Packaged the certificate with its key."
say ""

# ---------------------------------------------------------------- 4. notarization login
say "Notarization needs your Apple ID and an app-specific password. The one you"
say "made for VC Game Studio works here too; or make one at appleid.apple.com →"
say "Sign-In and Security → App-Specific Passwords."
read -r -p "Open that page now? [y/N] " answer
case "${answer:-n}" in [Yy]*) open_url "https://account.apple.com/account/manage" ;; esac
read -r -p "Apple ID (email): " apple_id
read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx, hidden): " app_password
say ""
[ -n "$apple_id" ] && [ -n "$app_password" ] || fail "Both are needed."
say ""

# Put one value where you can paste it: the clipboard, checked; if the
# clipboard did not take it, a text file opened in Notepad, deleted as soon as
# you press Enter.
clip_len() { powershell.exe -NoProfile -Command "[Console]::Out.Write((Get-Clipboard -Raw).Length)" 2>/dev/null | tr -d '\r'; }
give() {
  local n="$1" name="$2" value="$3" got file
  printf '%s' "$value" | copy 2>/dev/null || true
  got="$(clip_len || true)"
  if [ -n "$got" ] && [ "$got" = "${#value}" ]; then
    read -r -p "  $n/5  Name: $name   (value copied: paste with Ctrl+V) - press Enter when saved " _
  else
    file="$HOME/Desktop"; [ -d "$file" ] || file="$HOME"; file="$file/VCDIT-$name.txt"
    printf '%s' "$value" > "$file"
    (notepad.exe "$(cygpath -w "$file" 2>/dev/null || echo "$file")" &) 2>/dev/null || true
    say "  $n/5  Name: $name"
    say "        The value is open in Notepad: press Ctrl+A, Ctrl+C there, paste into GitHub, close Notepad."
    read -r -p "        Press Enter when saved (the file is then deleted) " _
    rm -f "$file"
  fi
}

# ---------------------------------------------------------------- 5. into GitHub
names=(CSC_LINK CSC_KEY_PASSWORD APPLE_TEAM_ID APPLE_ID APPLE_APP_SPECIFIC_PASSWORD)
values=("$csc_link" "$export_pass" "$team_id" "$apple_id" "$app_password")

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  for i in "${!names[@]}"; do
    printf '%s' "${values[$i]}" | gh secret set "${names[$i]}" --repo "$REPO" >/dev/null
    say "Set ${names[$i]}"
  done
else
  say "We'll paste them into GitHub together (5 secrets; replace any that already exist)."
  say "For each: click \"New repository secret\" (or the pencil next to an existing one),"
  say "type the name shown, paste (Ctrl+V) into Secret, save, then come back here."
  open_url "$SECRETS_PAGE"
  for i in "${!names[@]}"; do
    give "$((i + 1))" "${names[$i]}" "${values[$i]}"
  done
  printf ' ' | copy 2>/dev/null || true
fi

say ""
bold "Done. The next release build will sign and notarize the Mac installer."
say "Apple only checks the Apple ID and password during that build; if they're wrong, the build says so."
