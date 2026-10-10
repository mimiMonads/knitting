export const addOne = (value: number) => value + 1;

export const addOneLater = async (value: number) => value + 1;

export const fail = (message: string): never => {
  throw new Error(message);
};

export const stats = (value: { text: string }) => {
  const cleaned = String(value.text ?? "").trim();
  if (!cleaned) return { words: 0, chars: 0 };
  return {
    words: cleaned.split(/\s+/).length,
    chars: cleaned.length,
  };
};
