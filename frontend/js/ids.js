// Random ids. Memory ids match the server pattern: 9 base36 chars, a dash, 16 hex chars.
function hex(chars) {
  const bytes = new Uint8Array(chars / 2);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const newMemoryId = () => `${Date.now().toString(36).padStart(9, '0')}-${hex(16)}`;
export const newGuestId = () => hex(32);
