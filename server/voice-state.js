// In-memory map of parent (browser) call SID → { childSid, at } for the callee
// leg of an outbound Dial. Populated by the /api/voice/child-status webhook and
// read by the voicemail-drop endpoint. Ephemeral (fine — only for live calls).
export const vmDropChildMap = new Map()
