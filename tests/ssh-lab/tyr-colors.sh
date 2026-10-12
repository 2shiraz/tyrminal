#!/bin/sh
# Tyrminal lab fixture: prints 16-color, 256-color and 24-bit true-color samples with fixed,
# checkable values. Used by the native terminal tests; harmless to run anywhere.
e=$(printf '\033')
printf '%s[31mANSI-RED%s[0m %s[1;32mBOLD-GREEN%s[0m\n' "$e" "$e" "$e" "$e"
printf '%s[38;5;196mC256-196%s[0m %s[48;5;21m%s[38;5;231mBG256-21%s[0m\n' "$e" "$e" "$e" "$e" "$e"
printf '%s[38;2;10;200;30mTRUECOLOR-0AC81E%s[0m %s[48;2;200;10;120mTRUEBG-C80A78%s[0m\n' "$e" "$e" "$e" "$e"
i=0
line=""
while [ $i -lt 32 ]; do
  r=$((i * 8)); g=$((255 - i * 8))
  line="$line$e[48;2;$r;$g;128m "
  i=$((i + 1))
done
printf '%s%s[0m\n' "$line" "$e"
printf 'BOX ┌─┬─┐ │ │ │ ├─┼─┤ └─┴─┘ BLOCKS ▀▄█▌▐░▒▓ WIDE 日本語 EMOJI 🚀👩‍💻 COMBINING é\n'
printf 'COLORS-DONE\n'
