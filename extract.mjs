// 画像1枚を codex に投げて課題リストを JSON で抽出する
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'category'],
        properties: {
          text: { type: 'string', description: 'ホワイトボードに書かれた課題の文字起こし(1件分)' },
          category: {
            type: 'string',
            enum: ['仕事・学業', '生活・家事', 'お金', '交通・移動', '健康', '人間関係', '技術・IT', '地域・社会', '趣味・娯楽', 'その他'],
            description: '課題のカテゴリ',
          },
        },
      },
    },
  },
};

const PROMPT = `この画像はホワイトボードの写真です。「課題を1000個挙げる」イベントで書かれた課題が並んでいます。
以下を行ってください:
1. 画像に写っている課題を1件ずつすべて文字起こしする(箇条書きの点や番号は除き、本文のみ)。判読できない文字は文脈から補って構いませんが、まったく読めない項目は「(判読不能)」としてください。
2. 各課題に日本語のカテゴリ名を付ける。カテゴリは次の固定リストから選ぶこと: 「仕事・学業」「生活・家事」「お金」「交通・移動」「健康」「人間関係」「技術・IT」「地域・社会」「趣味・娯楽」「その他」。どうしても当てはまらない場合のみ「その他」を使う。カテゴリを新しく作らないこと。
課題以外のメモ(タイトル、日付、人名など)はリストに含めないでください。`;

export async function extractIssues(client, imagePath) {
  await client.init();
  const { thread } = await client.request('thread/start', {
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
  });

  let unsubscribe;
  const done = new Promise((resolve, reject) => {
    let lastAgentText = '';
    unsubscribe = client.onNotification((msg) => {
      if (msg.params?.threadId !== thread.id) return;
      if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage') {
        lastAgentText = msg.params.item.text ?? '';
      }
      if (msg.method === 'turn/completed') {
        const turn = msg.params.turn;
        if (turn?.status === 'failed') {
          reject(new Error(turn.error?.message ?? JSON.stringify(turn.error ?? {})));
        } else {
          resolve(lastAgentText);
        }
      }
      if (msg.method === 'error') {
        reject(new Error(JSON.stringify(msg.params)));
      }
    });
  });

  try {
    await client.request('turn/start', {
      threadId: thread.id,
      input: [
        { type: 'text', text: PROMPT },
        { type: 'localImage', path: imagePath },
      ],
      outputSchema: OUTPUT_SCHEMA,
    });
    const text = await done;
    return JSON.parse(text).issues;
  } finally {
    unsubscribe();
  }
}
