#!/bin/sh
set -eu
release=${1:?Pass a tmux release, for example task ci:tmux -- 3.5a}
case "$release" in 3.3a|3.5a|3.7c) ;; *) echo 'Supported CI releases: 3.3a, 3.5a, 3.7c' >&2; exit 2 ;; esac
base=$(pwd)/.temp/tmux-$release
mkdir -p "$base"
if [ ! -x "$base/bin/tmux" ]; then
  curl --fail --location --retry 3 "https://github.com/tmux/tmux/releases/download/$release/tmux-$release.tar.gz" --output "$base/source.tar.gz"
  tar -xzf "$base/source.tar.gz" -C "$base"
  cd "$base/tmux-$release"
  ./configure --prefix="$base" > "$base/build.log" 2>&1
  make -j2 >> "$base/build.log" 2>&1
  make install >> "$base/build.log" 2>&1
fi
"$base/bin/tmux" -V
