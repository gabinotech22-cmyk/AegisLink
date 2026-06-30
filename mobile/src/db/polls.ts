import { withDb } from './core';

export interface StoredPoll {
  id: string;
  question: string;
  options: string[];
  votes: number[];
  createdAt: number;
  groupId: string;
}

type PollRow = {
  id: string;
  question: string;
  options: string;
  votes: string;
  created_at: number;
  group_id: string;
};

function rowToPoll(r: PollRow): StoredPoll {
  return {
    id: r.id,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    votes: JSON.parse(r.votes) as number[],
    createdAt: r.created_at,
    groupId: r.group_id,
  };
}

export async function savePoll(p: StoredPoll): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO polls (id, question, options, votes, created_at, group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      p.id,
      p.question,
      JSON.stringify(p.options),
      JSON.stringify(p.votes),
      p.createdAt,
      p.groupId
    );
  });
}

export async function loadPolls(): Promise<StoredPoll[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<PollRow>(
      'SELECT id, question, options, votes, created_at, group_id FROM polls ORDER BY created_at DESC'
    );
    return rows.map(rowToPoll);
  });
}

export async function updatePollVotes(id: string, votes: number[]): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE polls SET votes = ? WHERE id = ?', JSON.stringify(votes), id);
  });
}
