# Reports the prompt, the current folder and where each command starts and ends to Tyrminal
# (OSC 133 and OSC 7 escape sequences). It only prints those sequences: it runs no commands,
# reads no input and changes nothing else.
if [[ -o interactive && -z ${__tyrminal_si-} && ${TERM-} != dumb ]]; then
  typeset -g __tyrminal_si=1
  __tyrminal_osc7() {
    emulate -L zsh
    local LC_ALL=C p=$PWD out= c i
    for (( i = 1; i <= ${#p}; i++ )); do
      c=${p[i]}
      case $c in
        ([-A-Za-z0-9/._~]) out+=$c ;;
        (*) printf -v c '%%%02X' "'$c"; out+=$c ;;
      esac
    done
    printf '\033]7;file://%s%s\033\\' "${HOST-}" "$out"
  }
  __tyrminal_precmd() {
    local ret=$?
    printf '\033]133;D;%s\033\\' "$ret"
    __tyrminal_osc7
    printf '\033]133;A\033\\'
    [[ $PS1 == *'133;B'* ]] || PS1+=$'%{\e]133;B\e\\%}'
    return $ret
  }
  __tyrminal_preexec() {
    printf '\033]133;C\033\\'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __tyrminal_precmd
  add-zsh-hook preexec __tyrminal_preexec
fi
