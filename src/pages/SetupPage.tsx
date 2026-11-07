import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function SetupPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Configurar Supabase</CardTitle>
          <CardDescription>
            Crie um projeto gratuito em{' '}
            <a
              href="https://supabase.com/dashboard"
              className="text-accent underline"
              target="_blank"
              rel="noreferrer"
            >
              supabase.com
            </a>
            , execute o SQL em <code className="text-foreground">supabase/migrations/</code> no
            editor SQL, copie a URL e a chave <em>anon</em> para um arquivo{' '}
            <code className="text-foreground">.env</code> na raiz do projeto:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 font-mono text-xs text-muted">
          <pre className="overflow-x-auto rounded-xl bg-background p-4 text-left text-foreground">
            {`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...`}
          </pre>
          <p>Reinicie <code className="text-foreground">npm run dev</code> após salvar.</p>
        </CardContent>
      </Card>
    </div>
  )
}
