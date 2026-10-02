#!/bin/sh
# A/B two Gea builds of bson-opmsg against Node, interleaved, best of $ROUNDS (default 3) ns per serialize.
# Usage: benchmarks/bson-opmsg-ab.sh dist/<a>/bench dist/<b>/bench [case ...]
a=$1
b=$2
shift 2
cases=${*:-"empty str4 num4 bool4 date4 oid4 bin1 nest3 arr4 insert-doc insert-cmd insert-cmd-inline find-cmd update-cmd delete-cmd"}
best() { sort -n | head -1; }
for c in $cases; do
  na=""; nb=""; nn=""
  for r in $(seq 1 "${ROUNDS:-3}"); do
    na="$na $("$a" "$c" | grep RESULT | cut -d, -f4)"
    nb="$nb $("$b" "$c" | grep RESULT | cut -d, -f4)"
    nn="$nn $(node benchmarks/bson-opmsg.mjs "$c" | grep RESULT | cut -d, -f4)"
  done
  ha=$("$a" "$c" | grep HEX | md5sum | cut -c1-8); hb=$("$b" "$c" | grep HEX | md5sum | cut -c1-8); hn=$(node benchmarks/bson-opmsg.mjs "$c" | grep HEX | md5sum | cut -c1-8)
  same=hex-identical; [ "$ha" = "$hn" ] && [ "$hb" = "$hn" ] || same=HEX-DIFFERS
  echo "$c A=$(echo $na | tr ' ' '\n' | best) B=$(echo $nb | tr ' ' '\n' | best) node=$(echo $nn | tr ' ' '\n' | best) $same"
done
