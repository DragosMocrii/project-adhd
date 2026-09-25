#!/usr/bin/env bash
# Agent tool selection, shared by post-create.sh and verify.sh.
#
# AGENT_TOOLS is a comma-separated list drawn from AGENT_TOOLS_KNOWN.
# Unset or empty selects every known tool, so an unconfigured project
# behaves exactly as it did before selection existed.
#
# Sourced on the host by adhd as well, so it must stay bash 3.2-compatible.
#
# This file is sourced, never executed.

AGENT_TOOLS_KNOWN=(claude codex gemini omp)
AGENT_TOOLS_SELECTED=()

agent_tools_die() {
  printf 'agent-tools: %s\n' "$*" >&2
  exit 1
}

agent_tools_join() {
  local joined
  joined=$(printf '%s, ' "$@")
  printf '%s' "${joined%, }"
}

agent_tools_lowercase() {
  local input="$1"
  local result=""
  local i char
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:$i:1}"
    case "$char" in
      A) result="${result}a" ;;
      B) result="${result}b" ;;
      C) result="${result}c" ;;
      D) result="${result}d" ;;
      E) result="${result}e" ;;
      F) result="${result}f" ;;
      G) result="${result}g" ;;
      H) result="${result}h" ;;
      I) result="${result}i" ;;
      J) result="${result}j" ;;
      K) result="${result}k" ;;
      L) result="${result}l" ;;
      M) result="${result}m" ;;
      N) result="${result}n" ;;
      O) result="${result}o" ;;
      P) result="${result}p" ;;
      Q) result="${result}q" ;;
      R) result="${result}r" ;;
      S) result="${result}s" ;;
      T) result="${result}t" ;;
      U) result="${result}u" ;;
      V) result="${result}v" ;;
      W) result="${result}w" ;;
      X) result="${result}x" ;;
      Y) result="${result}y" ;;
      Z) result="${result}z" ;;
      *) result="${result}${char}" ;;
    esac
  done
  printf '%s' "$result"
}

agent_tools_init() {
  local raw="${AGENT_TOOLS-}"
  local token known valid seen=' '
  local -a tokens=() normalized=()

  raw=${raw//,/ }
  read -r -a tokens <<< "$raw"

  if (( ${#tokens[@]} == 0 )); then
    AGENT_TOOLS_SELECTED=("${AGENT_TOOLS_KNOWN[@]}")
    return 0
  fi

  for token in "${tokens[@]}"; do
    token=$(agent_tools_lowercase "$token")
    valid=false
    for known in "${AGENT_TOOLS_KNOWN[@]}"; do
      if [[ "$token" == "$known" ]]; then
        valid=true
        break
      fi
    done
    if [[ "$valid" != true ]]; then
      agent_tools_die "unknown tool '$token' (valid: $(agent_tools_join "${AGENT_TOOLS_KNOWN[@]}"))"
    fi
    seen="$seen$token "
  done

  for known in "${AGENT_TOOLS_KNOWN[@]}"; do
    if [[ "$seen" == *" $known "* ]]; then
      normalized+=("$known")
    fi
  done
  AGENT_TOOLS_SELECTED=("${normalized[@]}")
}

agent_tool_selected() {
  local candidate=$1 tool

  for tool in "${AGENT_TOOLS_SELECTED[@]}"; do
    if [[ "$tool" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

agent_tools_summary() {
  agent_tools_join "${AGENT_TOOLS_SELECTED[@]}"
  printf '\n'
}
