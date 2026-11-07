export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      categories: {
        Row: {
          id: string
          user_id: string
          name: string
          parent_id: string | null
          icon: string | null
          color: string | null
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          parent_id?: string | null
          icon?: string | null
          color?: string | null
          sort_order?: number
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          parent_id?: string | null
          icon?: string | null
          color?: string | null
          sort_order?: number
          created_at?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          id: string
          user_id: string
          date: string
          amount_cents: number
          description_raw: string
          description_normalized: string | null
          kind: 'debit' | 'credit'
          account: string | null
          category_id: string | null
          credit_card_id: string | null
          import_batch_id: string | null
          import_file_id: string | null
          dedup_key: string | null
          /** Gerado na base; único por utilizador com data/valor/tipo/descrição lógica */
          logical_fingerprint: string
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          date: string
          amount_cents: number
          description_raw: string
          description_normalized?: string | null
          kind: 'debit' | 'credit'
          account?: string | null
          category_id?: string | null
          credit_card_id?: string | null
          import_batch_id?: string | null
          import_file_id?: string | null
          dedup_key?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          date?: string
          amount_cents?: number
          description_raw?: string
          description_normalized?: string | null
          kind?: 'debit' | 'credit'
          account?: string | null
          category_id?: string | null
          credit_card_id?: string | null
          import_batch_id?: string | null
          import_file_id?: string | null
          dedup_key?: string | null
          logical_fingerprint?: never
          created_at?: string
        }
        Relationships: []
      }
      credit_cards: {
        Row: {
          id: string
          user_id: string
          name: string
          last4: string | null
          brand: string | null
          limit_cents: number | null
          closing_day: number
          due_day: number
          color: string | null
          archived: boolean
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          last4?: string | null
          brand?: string | null
          limit_cents?: number | null
          closing_day?: number
          due_day?: number
          color?: string | null
          archived?: boolean
          sort_order?: number
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          last4?: string | null
          brand?: string | null
          limit_cents?: number | null
          closing_day?: number
          due_day?: number
          color?: string | null
          archived?: boolean
          sort_order?: number
          created_at?: string
        }
        Relationships: []
      }
      import_batches: {
        Row: {
          id: string
          user_id: string
          parser_id: string
          parser_version: string
          status: string
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          parser_id: string
          parser_version?: string
          status?: string
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          parser_id?: string
          parser_version?: string
          status?: string
          created_at?: string
        }
        Relationships: []
      }
      import_files: {
        Row: {
          id: string
          batch_id: string
          filename: string
          parser_id: string
          raw_error: string | null
          created_at: string
        }
        Insert: {
          id?: string
          batch_id: string
          filename: string
          parser_id: string
          raw_error?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          batch_id?: string
          filename?: string
          parser_id?: string
          raw_error?: string | null
          created_at?: string
        }
        Relationships: []
      }
      rules: {
        Row: {
          id: string
          user_id: string
          match_type: 'contains' | 'equals' | 'regex'
          pattern: string
          category_id: string
          priority: number
          enabled: boolean
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          match_type: 'contains' | 'equals' | 'regex'
          pattern: string
          category_id: string
          priority?: number
          enabled?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          match_type?: 'contains' | 'equals' | 'regex'
          pattern?: string
          category_id?: string
          priority?: number
          enabled?: boolean
          created_at?: string
        }
        Relationships: []
      }
      savings_entries: {
        Row: {
          id: string
          user_id: string
          goal_id: string
          date: string
          amount_cents: number
          note: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          goal_id: string
          date: string
          amount_cents: number
          note?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          goal_id?: string
          date?: string
          amount_cents?: number
          note?: string | null
          created_at?: string
        }
        Relationships: []
      }
      savings_goals: {
        Row: {
          id: string
          user_id: string
          name: string
          target_cents: number | null
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          target_cents?: number | null
          sort_order?: number
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          target_cents?: number | null
          sort_order?: number
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Category = Database['public']['Tables']['categories']['Row']
export type ImportBatch = Database['public']['Tables']['import_batches']['Row']
export type ImportFile = Database['public']['Tables']['import_files']['Row']
export type Transaction = Database['public']['Tables']['transactions']['Row']
export type Rule = Database['public']['Tables']['rules']['Row']
export type SavingsGoal = Database['public']['Tables']['savings_goals']['Row']
export type SavingsEntry = Database['public']['Tables']['savings_entries']['Row']
export type CreditCard = Database['public']['Tables']['credit_cards']['Row']
