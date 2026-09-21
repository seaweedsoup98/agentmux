import type { AgentEvent, AgentmuxState } from './types.js';

const MAX_EVENTS = 20_000;

export function appendEvent(
  state: AgentmuxState,
  input: Omit<AgentEvent, 'id' | 'seq'>,
): AgentEvent {
  const seq = state.nextEventSeq++;
  const event: AgentEvent = {
    id: 'evt_' + seq.toString(36).padStart(8, '0'),
    seq,
    ...input,
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  return event;
}
