#!/bin/bash

typ="dv_retx"

echo "${typ} = ["
for pfx in ${typ}_1 ${typ}_2 ${typ}_3; do
    echo -n "["
    for mttf in 4000 3000 2000 1500 1000 500 300; do
        filename="results/${pfx}_${mttf}_120.json"
        VAL=$(cat $filename | jq ".fail_pc")
        echo -n "$VAL, "
    done
    echo "],"
done
echo "]"
