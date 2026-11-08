#!/bin/sh
# Installs the Monaco build the Tdarr UI expects into <dest>/monaco/vs.
set -eu

version=0.36.1
integrity="sha512-/CaclMHKQ3A6rnzBzOADfwdSJ25BFoFT0Emxsc4zYVyav5SkK9iA6lEtIeuN/oRYbwPgviJT+t3l+sjFa28jYg=="
dest=${1:?usage: fetch-monaco.sh <private-dir>}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/monaco.tgz" "https://registry.npmjs.org/monaco-editor/-/monaco-editor-$version.tgz"
actual="sha512-$(openssl dgst -sha512 -binary "$work/monaco.tgz" | openssl base64 -A)"
[ "$actual" = "$integrity" ] || { echo "monaco-editor integrity mismatch" >&2; exit 1; }

tar -xzf "$work/monaco.tgz" -C "$work" package/min/vs
rm -rf "$dest/monaco"
mkdir -p "$dest/monaco"
mv "$work/package/min/vs" "$dest/monaco/vs"
echo "monaco-editor $version installed in $dest/monaco/vs"
