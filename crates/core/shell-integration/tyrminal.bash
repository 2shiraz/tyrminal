# Reports the prompt, the current folder and where each command starts and ends to Tyrminal
# (OSC 133 and OSC 7 escape sequences). It only prints those sequences: it runs no commands,
# reads no input and changes nothing else. Needs Bash 4.4 or newer for command boundaries.
if [[ $- == *i* && -z ${__tyrminal_si-} && ${TERM-} != dumb ]]; then
  __tyrminal_si=1
  __tyrminal_osc7() {
    local LC_ALL=C p=$PWD out= c i
    for ((i = 0; i < ${#p}; i++)); do
      c=${p:i:1}
      case $c in
        [-A-Za-z0-9/._~]) out+=$c ;;
        *) printf -v c '%%%02X' "'$c"; out+=$c ;;
      esac
    done
    printf '\033]7;file://%s%s\033\\' "${HOSTNAME-}" "$out"
  }
  __tyrminal_start() {
    local ret=$?
    printf '\033]133;D;%s\033\\' "$ret"
    __tyrminal_osc7
    printf '\033]133;A\033\\'
    return $ret
  }
  __tyrminal_end() {
    local ret=$?
    [[ $PS1 == *'133;B'* ]] || PS1+='\[\e]133;B\e\\\]'
    return $ret
  }
  PROMPT_COMMAND="__tyrminal_start${PROMPT_COMMAND:+;$PROMPT_COMMAND};__tyrminal_end"
  PS0='\e]133;C\e\\'"${PS0-}"
fi
