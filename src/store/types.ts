export type Status = "pending" | "approved" | "premium" | "banned";
export type Tier = "silver" | "gold";

export interface User {
  id: string;
  lang: string | null;
  status: Status;
  count: number;
  total_bytes: number;
  daily_bytes: number;
  daily_date: string | null;
  premium_tier: Tier | null;
  premium_until: number | null;
  premium_limit: number | null;
  referred_by: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface Category {
  id: number;
  name: string;
  file_count: number;
}
