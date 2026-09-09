#!/usr/bin/env bash
# Agent tool selection, shared by post-create.sh and verify.sh.
#
# AGENT_TOOLS is a comma-separated list drawn from AGENT_TOOLS_KNOWN.
# Unset or empty selects every known tool, so an unconfigured project
# behaves exactly as it did before selection existed.
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

agent_tools_init() {
  local raw="${AGENT_TOOLS-}"
  local token known valid
  local -a tokens=() normalized=()
  local -A seen=()

  raw=${raw//,/ }
  read -r -a tokens <<< "$raw"

  if (( ${#tokens[@]} == 0 )); then
    AGENT_TOOLS_SELECTED=("${AGENT_TOOLS_KNOWN[@]}")
    return 0
  fi

  for token in "${tokens[@]}"; do
    token=$(printf '%s' "$token" | tr '[:upper:]' '[:lower:]')
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
    seen["$token"]=1
  done

  for known in "${AGENT_TOOLS_KNOWN[@]}"; do
    if [[ -n "${seen[$known]-}" ]]; then
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
