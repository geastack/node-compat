#!/bin/sh
# Per-case ns/serialize for the Gea build ($1) against Node, plus a hex check.
# Usage: benchmarks/bson-opmsg-compare.sh dist/<out>/bench [case ...]
bench=$1
shift
cases=${*:-"empty str4 num4 bool4 date4 oid4 bin1 nest3 arr4 insert-doc insert-cmd insert-cmd-inline find-cmd update-cmd delete-cmd"}
for c in $cases; do
  n=$(node benchmarks/bson-opmsg.mjs "$c")
  g=$("$bench" "$c")
  nn=$(echo "$n" | grep RESULT | cut -d, -f4)
  gn=$(echo "$g" | grep RESULT | cut -d, -f4)
  if [ "$(echo "$n" | grep HEX)" = "$(echo "$g" | grep HEX)" ]; then same=hex-identical; else same=HEX-DIFFERS; fi
  echo "$c node=${nn}ns gea=${gn}ns $same"
done
