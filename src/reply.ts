import type { Context } from 'grammy';

/** Telegram rejeita qualquer mensagem acima de 4096 chars (UTF-16 code units) com
 * "400: Bad Request: message is too long". `limit` fica um pouco abaixo disso de propósito —
 * Telegram conta entidades/formatação além do texto puro, e isso dá margem sem complicar a conta.
 *
 * Estratégia de corte, em ordem de preferência (nunca perde caracteres, nunca gera chunk vazio):
 *   1. quebra em fronteira de parágrafo/linha (`\n`);
 *   2. se uma "linha" sozinha ainda estoura o limite, quebra em espaços;
 *   3. se um único token (sem espaço) ainda estoura o limite, corta na marra (último recurso).
 */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) { chunks.push(current); current = ''; }
  };

  // Divide em linhas, preservando as quebras (\n) na hora de recompor.
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const sep = i < lines.length - 1 ? '\n' : '';
    let piece = line + sep;

    while (piece.length > 0) {
      if (current.length + piece.length <= limit) {
        current += piece;
        piece = '';
        continue;
      }

      // A linha inteira não cabe no chunk atual — fecha o que tem e tenta a linha sozinha num
      // chunk novo.
      if (current.length > 0) { flush(); continue; }

      // Chunk vazio e a linha ainda não cabe: quebra por espaço.
      if (piece.length <= limit) { current = piece; piece = ''; continue; }

      const spaceIdx = piece.lastIndexOf(' ', limit);
      if (spaceIdx > 0) {
        current = piece.slice(0, spaceIdx + 1);
        piece = piece.slice(spaceIdx + 1);
        flush();
        continue;
      }

      // Sem espaço nenhum antes do limite (token gigante) — corta na marra, último recurso.
      current = piece.slice(0, limit);
      piece = piece.slice(limit);
      flush();
    }
  });
  flush();

  return chunks;
}

/** Envia `text` em um ou mais chunks (`splitForTelegram`), cada um AWAITED em ordem — nunca
 * dispara um `ctx.reply` sem esperar (isso escaparia do try/catch do chamador e do `bot.catch`,
 * podendo derrubar o processo sob long polling). */
export async function safeReply(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await ctx.reply(chunk);
  }
}
