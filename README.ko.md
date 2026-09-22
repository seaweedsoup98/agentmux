# agentmux

[English](README.md) | **한국어**

**Codex, Claude Code, Antigravity를 서로의 subagent로 사용하세요. 익숙한 coding-agent UI를 그대로 유지하면서 가능합니다.**

[![npm](https://img.shields.io/npm/v/%40jiho.ko%2Fagentmux?label=npm)](https://www.npmjs.com/package/@jiho.ko/agentmux)
[![CI](https://github.com/seaweedsoup98/agentmux/actions/workflows/ci.yml/badge.svg)](https://github.com/seaweedsoup98/agentmux/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

`agentmux`는 coding-agent CLI들을 연결하는 로컬 MCP orchestration layer입니다. Codex, Claude Code, Antigravity 중 원하는 도구를 control tower로 그대로 사용하면서, 다른 provider의 agent에게 작업을 위임하고 각 provider의 native session을 유지할 수 있습니다.

## 빠른 시작

**요구사항:** Node.js 20+와 지원하는 provider CLI 중 하나 이상(`codex`, `claude`, `agy`)이 설치되어 있어야 합니다.

현재 PC에 설치된 지원 가능한 coding-agent host에 agentmux를 native plugin으로 설치합니다.

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install
```

설치 상태를 확인합니다.

```bash
npx -y '@jiho.ko/agentmux@latest' plugins status
```

설치 후에는 Codex, Claude Code, Antigravity를 재시작하거나 새 세션을 열어 plugin의 MCP tool과 orchestration skill을 로드하세요.

기존에 agentmux를 direct MCP server로 등록해 두었다면, native plugin 설치가 성공한 뒤 중복 MCP 등록까지 안전하게 제거할 수 있습니다.

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install --replace-mcp
```

## 왜 agentmux인가?

- **기존 agent UI를 그대로 사용합니다.** 별도의 multi-agent dashboard가 필요하지 않습니다. Codex, Claude Code, Antigravity 중 지금 쓰는 도구가 그대로 control tower가 됩니다.
- **하나의 작업에서 provider를 섞어 쓸 수 있습니다.** Codex가 Claude Code나 Antigravity에 일을 맡길 수 있고, managed agent가 다시 다른 provider의 child agent를 만들 수도 있습니다.
- **native conversation을 유지합니다.** Codex의 `thread_id`, Claude의 `session_id`, Antigravity의 `conversation_id`를 보존하므로 같은 provider-native session에서 이어서 작업할 수 있습니다.
- **위임한 작업이 쉽게 끊기지 않습니다.** 기본적으로 job은 detached local broker가 실행하며, message, delegation, orchestration event는 MCP/UI process가 재시작되어도 유지됩니다.
- **병렬 작업의 파일 충돌을 줄일 수 있습니다.** 쓰기 권한이 있는 agent들을 Git worktree로 분리하고, 변경사항을 base workspace에 적용하기 전에 diff/apply를 명시적으로 검토할 수 있습니다.
- **기존 provider 인증을 그대로 사용합니다.** agentmux는 설치된 provider CLI를 호출하며 provider credential 자체를 저장하지 않습니다.
- **세 환경 모두 native plugin으로 설치할 수 있습니다.** Codex, Claude Code, Antigravity를 하나의 installer 명령으로 지원합니다.

## 사용 예시

### Cross-provider control tower

가장 익숙한 agent를 supervisor로 두고 전문 작업을 다른 provider에 맡깁니다.

```text
Codex를 control tower로 사용해.
Claude Code에게 API 설계를 리뷰하게 해.
Antigravity에게 구현의 edge case를 점검하게 해.
둘 다 끝나면 의견이 다른 부분을 비교해서 정리해.
```

### 독립적인 병렬 리뷰

같은 문제를 여러 provider가 독립적으로 검토하게 한 뒤 비교합니다.

```text
이 pull request를 Codex reviewer 한 명과 Antigravity reviewer 한 명에게 맡겨.
서로 독립적으로 검토하게 한 뒤 결과를 비교해.
```

### 구현자 + 리뷰어 분리

구현과 검증을 서로 다른 agent에 맡깁니다.

```text
Claude Code에게 isolated worktree에서 구현을 맡겨.
그 결과 diff를 main workspace에 적용하기 전에 Codex가 리뷰하게 해.
```

### 오래 걸리는 위임 작업

한 UI에서 작업을 시작한 뒤 해당 UI나 MCP process가 종료되더라도 local broker가 실행 소유권을 유지할 수 있습니다. 이후 shared state, job, delegation, event API를 통해 다시 확인할 수 있습니다.

## 지원 provider

| Provider | Worker CLI | Native plugin | Native session resume |
| --- | --- | --- | --- |
| Codex | `codex` | ✓ | `thread_id` |
| Claude Code | `claude` | ✓ | `session_id` |
| Antigravity | `agy` | ✓ | `conversation_id` |

## 동작 구조

```text
          기존에 사용하던 coding-agent UI
       Codex / Claude Code / Antigravity
                     |
                agentmux MCP
                     |
          local orchestration runtime
          /          |           \
       Codex       Claude     Antigravity
       worker      worker        worker
```

interactive host는 외부 control tower로 남을 수 있고, managed agent가 다시 child agent들을 감독하는 구조도 가능합니다. agentmux는 별도의 UI를 만드는 대신 shared session, delegation, messaging, event, execution, workspace layer를 제공합니다.

> **상태:** early alpha입니다. core runtime과 실제 Codex ↔ Antigravity delegation 경로는 검증했지만, CLI 명령이나 plugin integration 방식은 앞으로 일부 변경될 수 있습니다.

## 현재 제공 범위

MCP server는 provider-neutral session API를 제공합니다.

- `spawn` / `spawn_many` — 하나 이상의 agent session을 만들고 job을 비동기로 시작
- `send` — 같은 provider-native conversation을 이어서 실행
- `whoami` — inherited runtime context를 이용해 현재 managed child agent의 identity 확인
- `message_send`, `inbox`, `message_ack` — 저장되고 발신자가 기록되는 agent-to-agent messaging
- `delegate`, `delegation_list`, `delegation_accept`, `delegation_complete`, `delegation_cancel` — 명시적인 작업 위임과 소유권 추적
- `events` / `events_wait` — MCP host 간 공유되는 durable ordered orchestration history
- `status` — agent와 최신 job 상태 확인
- `result` / `wait` — 결과 조회 또는 여러 job 대기
- `list` — local session 목록
- `kill` — 실행 중 job 취소 및 session 종료
- `team_create`, `team_status`, `team_list` — session 그룹과 supervision 구조 관리
- `providers` — 지원 runtime adapter 확인
- `doctor` — provider 설치/auth 상태와 MCP host 설정 확인

각 provider의 native session ID를 그대로 보존합니다.

| Provider | CLI | Native session ID |
| --- | --- | --- |
| Codex | `codex exec --json` | `thread_id` |
| Claude Code | `claude -p --output-format stream-json --verbose` | `session_id` |
| Antigravity | `agy -p --output-format stream-json` | `conversation_id` |

## Main agent와 subagent

`agentmux`는 특정 model을 main agent로 고정하지 않습니다.

team에 `supervisorAgentId`가 없다면 interactive MCP host가 control tower입니다.

```text
사용자
 |
Codex UI                 <- external supervisor
 |
agentmux team
 |- Claude reviewer
 |- Antigravity implementer
 `- Codex researcher
```

managed agent도 child를 감독할 수 있습니다. provider subprocess는 `AGENTMUX_AGENT_ID`, `AGENTMUX_TEAM_ID`, `AGENTMUX_PARENT_AGENT_ID`, `AGENTMUX_ROLE`을 상속합니다. 해당 coding agent가 설정된 agentmux MCP server를 실행하면 `whoami`가 inherited identity를 해석하고, nested `spawn`은 자동으로 같은 team 안에 child를 만듭니다.

managed agent의 권한은 team 단위로 제한됩니다. 같은 team의 agent를 확인하고 메시지를 보낼 수 있으며, 자신의 inbox만 읽고 자신 또는 descendant만 중지할 수 있습니다. 반면 inherited agent ID가 없는 외부 Codex/Claude Code/Antigravity UI는 unrestricted control tower로 동작합니다.

이 경계는 coordination boundary이며 OS-level security sandbox는 아닙니다.

같은 머신의 여러 agentmux MCP process가 동일한 state를 안전하게 공유할 수 있습니다. state mutation은 inter-process filesystem lock으로 직렬화되고 atomic replacement 방식으로 저장됩니다.

provider job은 기본적으로 job을 시작한 MCP stdio process가 아니라 작은 detached local broker가 소유합니다. 따라서 Codex UI, Claude Code UI, Antigravity UI와 nested managed agent가 같은 local execution owner를 공유할 수 있고, 작업을 시작한 UI나 MCP process가 종료되더라도 위임된 작업이 계속 실행될 수 있습니다.

broker는 local Unix socket 또는 Windows named pipe와 state별 capability token을 사용하며, 일정 시간 idle 상태가 지속되면 자동 종료됩니다.

broker를 시작하지 못하면 agentmux는 MCP-owned execution으로 fallback하며, `runtime_status`에서 현재 mode를 확인할 수 있습니다. `AGENTMUX_EXECUTION=local`을 설정하면 이 fallback 방식을 명시적으로 강제할 수 있습니다.

## 요구사항

- Node.js 20+
- provider CLI는 모두 선택 사항입니다. 실제로 사용할 worker만 설치하면 됩니다: `codex`, `claude`, `agy`
- Git은 worktree isolation/integration을 사용할 때만 필요합니다.

따라서 Codex + Antigravity만 사용하는 설치, Claude Code만 사용하는 설치, provider 없이 agentmux만 먼저 설치한 상태도 모두 유효합니다.

## 설치 상세

일반적인 설치는 이 문서 상단의 **빠른 시작**을 사용하면 됩니다. 아래 내용은 direct MCP fallback과 개발 환경용 설치를 설명합니다.

### Direct MCP fallback

plugin 대신 MCP server를 직접 등록하고 싶다면 다음을 사용합니다.

```bash
npx -y '@jiho.ko/agentmux@latest' setup
```

또는 CLI를 전역 설치할 수 있습니다.

```bash
npm install -g '@jiho.ko/agentmux'
agentmux setup
```

scoped package를 따옴표로 감싼 이유는 PowerShell과 POSIX shell 모두에서 같은 명령을 그대로 붙여넣을 수 있게 하기 위해서입니다.

### 개발용 local checkout

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm run build
npm link
agentmux setup
```

interactive setup은 설치된 Codex, Claude Code, Antigravity host를 감지하고 어떤 host를 설정할지 묻습니다. non-interactive 예시는 다음과 같습니다.

```bash
agentmux setup --hosts codex,antigravity
agentmux setup --hosts claude
agentmux setup --yes
agentmux setup --hosts codex,antigravity --dry-run
```

setup은 각 host의 native 설정 경로를 사용합니다.

- Codex: `codex mcp add`
- Claude Code: user-scope `claude mcp add`
- Antigravity: `~/.gemini/config/mcp_config.json`의 `mcpServers.agentmux`만 merge

기존 Antigravity MCP 항목과 관계없는 JSON key는 그대로 보존됩니다. host에 native agentmux plugin이 이미 설치되어 있으면 setup은 중복 tool을 피하기 위해 direct MCP를 추가하지 않습니다.

설정 후 다음으로 확인할 수 있습니다.

```bash
agentmux doctor
agentmux doctor --json
```

### Provider 상태와 인증

`agentmux doctor`는 모든 provider를 필수 dependency로 취급하지 않고, 설치 상태와 인증 상태를 분리해서 보여줍니다.

대표적인 상태는 다음과 같습니다.

- `ready`: CLI가 설치되어 있고 inference를 발생시키지 않는 auth status 확인 결과 로그인 상태
- `auth_required`: CLI는 설치되어 있지만 로그인이 필요함
- `installed`: CLI는 설치되어 있지만 실제 model request 없이 인증 상태를 확인할 수 없음
- `missing`: CLI가 설치되어 있지 않음
- `unhealthy`: status probe 자체가 예상치 못하게 실패함

Codex는 `codex login status`, Claude Code는 `claude auth status`를 사용합니다. Antigravity에는 quota를 사용하지 않는 문서화된 shell auth-status 명령이 없으므로, doctor는 model request를 발생시키거나 browser login을 열지 않고 auth를 `unknown`으로 표시합니다. 실제 headless Antigravity 실행이 최종적인 auth 확인 수단입니다.

provider가 없다면 doctor는 임의로 소프트웨어를 설치하지 않고 공식 설치 명령을 출력합니다. provider 설치는 PATH, shell profile, system state를 변경할 수 있기 때문에 명시적인 사용자 동작으로 남겨둡니다.

인증이 만료되면 agentmux가 provider credential을 저장하거나 복구하지 않습니다. provider 자체를 이용해 다시 로그인하세요.

```text
Codex:       codex login
Claude Code: claude auth login
Antigravity: agy를 interactive하게 한 번 실행해 로그인
```

runtime에서 executable 누락이나 인증 오류로 보이는 실패가 발생하면 대응 방법도 함께 표시합니다.

setup이 npx cache에서 실행되는 경우 ephemeral cache path를 MCP에 고정하지 않고 `npx -y @jiho.ko/agentmux@latest`를 stable MCP launch command로 등록합니다.

## Native plugin

repository는 Codex/OpenAI, Claude Code, Antigravity용 native plugin bundle을 모두 포함합니다. 권장 installer는 다음입니다.

```bash
npx -y '@jiho.ko/agentmux@latest' plugins install
```

### Codex / OpenAI

직접 설치할 경우 다음과 같습니다.

```bash
codex plugin marketplace add seaweedsoup98/agentmux --ref main
codex plugin add agentmux@agentmux
```

repository marketplace는 `.agents/plugins/marketplace.json`, plugin bundle은 `plugins/codex`에 있습니다.

### Claude Code

직접 설치할 경우 다음과 같습니다.

```bash
claude plugin marketplace add seaweedsoup98/agentmux@main --scope user
claude plugin install agentmux@agentmux --scope user
claude plugin enable agentmux@agentmux --scope user
```

Claude marketplace는 `.claude-plugin/marketplace.json`, plugin bundle은 `plugins/claude`에 있습니다.

### Antigravity

공통 installer는 npm package 안에 포함된 plugin bundle을 자동으로 사용합니다. repository checkout에서 직접 설치하는 경우 다음과 같습니다.

```bash
agy plugin install ./plugins/antigravity
```

plugin bundle은 `plugins/antigravity`에 있습니다.

세 native plugin 모두 orchestration skill을 포함하고 동일한 published MCP runtime인 `npx -y @jiho.ko/agentmux@latest`를 실행합니다. direct MCP registration과 native plugin 설치는 서로 다른 integration 방식입니다. 기존 direct MCP에서 plugin으로 옮길 때는 `--replace-mcp`를 사용하면 중복 tool 노출을 피할 수 있습니다.

## 개발

```bash
git clone https://github.com/seaweedsoup98/agentmux.git
cd agentmux
npm install
npm run check
```

stdio 기반 MCP server를 실행하려면:

```bash
npm run dev
```

server는 local session metadata를 `~/.agentmux/state.json`에 저장합니다. 다른 위치를 쓰고 싶으면 `AGENTMUX_HOME`을 설정하세요.

local agentmux MCP process들은 동일한 state store를 공유합니다. read는 최신 snapshot을 사용하고, mutation은 process-safe lock과 atomic file replacement를 통해 저장됩니다. Windows에서 일시적인 replace 실패가 발생하면 non-atomic delete-and-rewrite로 fallback하지 않고 재시도합니다.

실행 중인 job은 owner PID/instance를 기록하므로, 다른 MCP host가 시작되더라도 살아 있는 host가 소유한 작업을 잘못 recover하거나 overwrite하지 않습니다.

## 예시

MCP server가 host에 등록되어 있으면 host agent에게 자연어로 다음처럼 요청할 수 있습니다.

```text
이 작업을 위한 team을 만들어.
Antigravity agent 두 개를 띄워서 이 repository를 서로 독립적으로 리뷰하게 해.
그 다음 Codex agent 하나를 사용해서 두 결과를 비교하고 공통 결론을 정리해.
```

host는 계속 control tower 역할을 하고, `agentmux`는 runtime/session layer를 제공합니다.

### Agent-to-agent messaging

managed child는 `whoami`로 자신과 team을 확인하고, `team_status`로 peer를 볼 수 있습니다. `send`는 자신의 managed session을 이어서 실행하거나 external control tower가 session을 resume하는 용도입니다. peer-to-peer 작업 전달에는 attributed message 또는 tracked delegation을 사용합니다.

```text
message_send(
  to_agent_id="<peer>",
  message="repository interface를 변경했어. 구현을 이 변경사항 기준으로 맞춰줘.",
  wake=false
)
```

message는 delivery 전에 state에 저장됩니다. `wake=false`면 peer inbox에 unread 상태로 남습니다. `wake=true`면 peer가 idle이고 resume 가능한 경우 해당 provider-native session을 추가로 깨웁니다. peer가 busy이면 wake는 실패하지만 message 자체는 inbox에 남습니다.

wake job은 detached broker가 소유하므로 이를 시작한 MCP host보다 오래 실행될 수 있습니다. 현재 turn이 결과에 의존한다면 `wait`를 호출하고, 그렇지 않다면 위임된 작업을 계속 실행시킨 뒤 job status나 durable event stream으로 나중에 확인할 수 있습니다.

```text
inbox(unread_only=true)
message_ack(message_ids=["msg_..."])
```

별도의 agentmux UI 없이도 agent 간 통신이 가능합니다.

### Tracked delegation

단순 coordination에는 message를 사용하고, 작업의 소유권과 완료 상태를 관리해야 할 때는 delegation을 사용합니다.

```text
delegate(
  to_agent_id="<specialist>",
  task="provider adapter를 검토하고 구체적인 결함을 보고해.",
  wake=true
)
```

delegation은 target이 수락하기 전 `pending`, 작업 중에는 `active`, 완료되면 `completed` 또는 `canceled`가 됩니다. `wake=true`이고 target이 idle/resumable이면 즉시 wake되고 delegation도 자동으로 active가 됩니다. target이 busy여서 wake가 실패하면 task는 pending delegation과 inbox message로 그대로 저장됩니다.

managed agent는 같은 team 안에서만 delegation할 수 있습니다. assigned agent가 명시적으로 accept/complete할 수 있고, sender 또는 receiver는 terminal state가 아닌 delegation을 cancel할 수 있습니다. delegation transition은 durable event stream에도 기록됩니다.

### Durable orchestration event

중요한 lifecycle transition은 process-safe ordered event stream에도 기록됩니다. event는 monotonic `seq` cursor를 사용하며 team 생성, agent spawn/stop, job create/start/complete/cancel, message delivery/read/wake, workspace integration, bounded provider progress 등을 포함합니다.

```text
events(after_seq=0, team_id="<team>")
events_wait(after_seq=42, timeout_ms=30000)
```

`events_wait`는 tight polling 대신 bounded long-poll을 사용합니다. cursor도 동일한 transactional state store에 저장되므로 Codex UI, Claude Code UI, Antigravity UI, nested managed agent가 서로 다른 agentmux MCP process에 연결되어 있어도 같은 orchestration history를 볼 수 있습니다. managed agent는 자신의 team 범위로 제한됩니다.

event stream은 의도적으로 metadata 중심입니다. message body, assistant text delta, command 내용, raw provider stdout은 event에 복제하지 않습니다. 상세 내용은 inbox/job API에 남습니다.

provider adapter는 필요한 structured progress만 정규화합니다.

- Codex `exec --json`: response text를 제외한 item start/completion
- Claude Code `stream-json`: tool-use / tool-result transition
- Antigravity `stream-json`: response 외 step state transition

이들은 `provider.progress`, `provider.tool_started`, `provider.tool_completed` event로 저장됩니다. 1초 이내의 완전히 동일한 중복 event는 합쳐지고, durable event journal은 무한히 커지지 않도록 bounded 상태로 유지됩니다.

## Workspace isolation

spawn된 각 agent는 `workspace: shared | worktree | auto`를 사용할 수 있습니다.

- `shared`: 지정한 working directory를 그대로 사용
- `worktree`: `~/.agentmux/worktrees/<agent-id>` 아래에 detached Git worktree 생성
- `auto`: 기본값. read-only agent는 shared workspace를 사용하고, writable agent가 동시에 여러 개 실행되는 상황에서는 자동으로 격리

worktree는 Git `HEAD`에서 생성되며 정확한 base commit을 agent session에 기록합니다. local edit을 조용히 누락시키는 일을 막기 위해 dirty repository에서는 worktree 생성을 거부합니다. 먼저 commit/stash하거나 명시적으로 `shared`를 선택하세요.

control tower는 isolated writable work를 명시적으로 확인하고 반영할 수 있습니다.

```text
workspace_status(agent_id="<agent>")
workspace_diff(agent_id="<agent>")
workspace_apply(agent_id="<agent>")
kill(agent_id="<agent>")
workspace_cleanup(agent_id="<agent>", force=true)
```

`workspace_diff`는 temporary Git index를 이용해 하나의 base-relative patch를 만듭니다. committed, staged, unstaged, deleted, untracked file을 포함하면서 agent의 실제 index는 변경하지 않습니다.

`workspace_apply`는 external control tower에서만 사용할 수 있으며 dirty base repository를 거부하고 `git apply --check`를 실행합니다. 자동 merge는 수행하지 않습니다.

cleanup은 session이 종료된 뒤에만 가능하고, dirty isolated worktree는 명시적인 `force=true`가 필요합니다.

이 구조는 parallel writer의 작업을 재현 가능하게 유지하면서 최종 integration 권한은 interactive control tower에 남깁니다.

## Access mode

`spawn`은 provider-neutral access mode를 받습니다. adapter는 각 provider의 가장 가까운 native 동작으로 매핑합니다.

| agentmux | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| `read-only` | `read-only` sandbox | `plan` permission mode | `plan` mode + terminal sandbox |
| `workspace-write` | `workspace-write` sandbox | `acceptEdits` | `accept-edits` + terminal sandbox |
| `full` | `danger-full-access` | permission prompt 생략 | `accept-edits` + permission prompt 생략 |

이 매핑은 의도적으로 보수적으로 설계되어 있으며 provider 간 security model이 완전히 동일하다는 뜻은 아닙니다.

## 설계 원칙

1. 기존 Codex, Claude Code 또는 다른 MCP-host UI를 그대로 사용합니다.
2. main/subagent 관계를 model 속성이 아니라 session 관계로 취급합니다.
3. provider session을 stateless API call로 평탄화하지 않고 native session을 유지합니다.
4. workspace isolation은 선택적으로 사용하고, `auto`는 동시 writable agent가 있을 때만 자동 격리합니다.
5. core는 작게 유지합니다. worktree, messaging policy, richer supervision은 provider adapter 위 계층에 둡니다.

## 의도적으로 하지 않는 것

runtime을 작게 유지하기 위해 agentmux는 다음 기능을 의도적으로 추가하지 않습니다.

- 별도 multi-agent UI — 기존 Codex, Claude Code, Antigravity UI를 그대로 사용
- workflow/task-DAG DSL — nested agent와 tracked delegation으로 작업 ownership을 표현
- 두 번째 push/message transport — `events_wait`을 shared long-poll primitive로 사용
- 자동 worktree merge — control tower가 isolated change를 직접 확인하고 적용
- core 내부의 provider-specific workflow abstraction — provider adapter는 execution/session/progress normalization까지만 담당

named role은 persistent template이 아니라 가벼운 session metadata로 유지합니다.

## 실제 provider 검증

일반 CI는 deterministic fake provider executable을 사용하므로 Codex, Claude Code, Antigravity quota를 소비하지 않습니다. `auth_required` 상태의 provider는 valid partial installation까지 실패시키지 않도록 기본 real-provider smoke에서 제외됩니다.

설치된 실제 provider CLI를 명시적으로 검증하려면:

```bash
npm run e2e:real
```

smoke harness는 설치된 provider를 감지한 뒤 read-only prompt로 initial spawn과 native-session resume을 순차 검증합니다. 지나치게 빠른 요청을 피하기 위해 기본적으로 요청 사이에 2초 간격을 둡니다.

provider를 선택하려면:

```bash
npm run e2e:real -- --providers codex,claude
```

전체 heterogeneous parent/child matrix를 실행하려면:

```bash
npm run e2e:real:matrix
```

matrix mode는 선택된 모든 cross-provider parent → child 조합, nested managed identity, wake/resume delegation, delegation completion을 검증합니다. 결과는 stdout에 machine-readable JSON 하나로 출력되며 disposable local state/workspace를 사용합니다. `full` access는 요청하지 않습니다.

요청 간격과 timeout은 `AGENTMUX_E2E_DELAY_MS`, `AGENTMUX_E2E_TIMEOUT_MS`로 조정할 수 있습니다.

## 라이선스

Apache-2.0
