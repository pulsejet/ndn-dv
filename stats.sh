#!/bin/bash

OUTPUTS=$(cat /tmp/minindn/**/log/ping.log)

FAIL=$(echo $OUTPUTS | tr -cd 'x' | wc -c)
SUCCESS=$(echo $OUTPUTS | tr -cd '.' | wc -c)

FRAC=$(echo "scale=2; $SUCCESS / ($SUCCESS + $FAIL)" | bc)

echo -e "TOTAL: $((SUCCESS + FAIL))"
echo -e "SUCCESS: $FRAC"
