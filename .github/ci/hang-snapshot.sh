#!/usr/bin/env bash
# Print what a hung test shard is doing, while it is still alive: the process
# tree, then each bun process's kernel wait channel, threads and open files.
ps -eo pid,ppid,etimes,stat,wchan:32,args --forest | grep -v '\[' | cut -c1-260
for pid in $(pgrep -x bun); do
  echo "== bun $pid: $(tr '\0' ' ' < /proc/$pid/cmdline | cut -c1-200)"
  sudo cat /proc/$pid/stack 2>/dev/null | head -8
  for task in /proc/$pid/task/*; do
    echo "  task ${task##*/} $(cat "$task/comm") $(cat "$task/wchan")"
  done | sort -k3 | uniq -c -f2 | head -20
  sudo ls -l /proc/$pid/fd 2>/dev/null | awk '{print $NF}' | sort | uniq -c | sort -rn | head -12
done
# The last test each worker started (test/preload.ts writes these traces).
shopt -s nullglob
for trace in "$LLMWIKI_TEST_TRACE"/*.log; do
  echo "== trace $(basename "$trace"): $(wc -l < "$trace") starts"
  tail -3 "$trace"
done
