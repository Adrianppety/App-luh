# Controle de vendas

Aplicativo PWA para clientes, catálogo de produtos, vendas, pagamentos e relatórios. O Supabase é a fonte principal dos dados; o IndexedDB/Dexie mantém a cópia offline e uma fila de alterações pendentes.

## Configuração do Supabase

1. Crie um projeto Supabase e copie a URL e a chave pública (anon/publishable) para `.env.local`, usando `.env.example` como modelo. Essas variáveis são públicas por natureza; nunca use a chave `service_role` no frontend.
2. Aplique `supabase/migrations/202611100001_initial_schema.sql` pelo SQL Editor do projeto ou pelo Supabase CLI.
3. Publique a função de autenticação:

   ```sh
   supabase link --project-ref SEU_PROJECT_REF
   supabase functions deploy username-auth
   ```

   A função usa `SUPABASE_SERVICE_ROLE_KEY` exclusivamente no ambiente seguro do Supabase. Configure-a como secret da função se ela não estiver disponível por padrão:

   ```sh
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=SUA_CHAVE_SERVICE_ROLE
   ```

4. Reinicie o servidor local depois de configurar `.env.local`:

   ```sh
   npm install
   npm run dev
   ```

O cadastro usa nome de usuário e senha, cria a conta no Supabase e inicia a sessão. O usuário é convertido em um endereço técnico interno para o Supabase Auth; nenhum e-mail é solicitado ou enviado. Como não há e-mail/telefone de recuperação, a redefinição de senha deve ser feita pelo painel do Supabase. A chave administrativa só existe no ambiente da Edge Function.

## Migração dos dados locais

Entre na conta primeiro no navegador/aparelho que contém os dados Dexie existentes. Na primeira sincronização, clientes, vendas, pagamentos e comissão são associados à conta e enviados com identificadores estáveis; repetir a sincronização não cria cópias. Depois, use o mesmo usuário e senha nos demais dispositivos. Uma base antiga independente em outro navegador não tem identificadores compartilhados com a primeira base; não a migre como se fosse a mesma cópia sem antes exportar e revisar os dados.

Vendas e pagamentos são preservados como histórico. Clientes e produtos são arquivados em vez de apagados. A restauração de backup mescla registros e não limpa movimentos já existentes. O backup JSON inclui clientes, produtos, vendas, pagamentos e comissão.

## Sincronização e dados

- RLS restringe as tabelas à conta autenticada; não há política de exclusão de registros financeiros.
- A tabela `sales` guarda itens como snapshots (nome, código e preço) para preservar o histórico mesmo que o catálogo mude. `products` guarda o catálogo reutilizável.
- O resumo de saldo é calculado a partir de vendas e pagamentos; `client_balances` é uma view, não uma cópia financeira editável.
- IDs UUID gerados no aparelho tornam retries idempotentes. A fila Dexie é reenviada ao reconectar, e Realtime mais uma verificação periódica atualizam outros dispositivos.
- A faixa de sincronização indica estado sincronizado, offline, pendente ou erro. Um erro mantém o registro local pendente e visível; não é descartado automaticamente.

## Teste de sincronização real

Após configurar e publicar o Supabase, entre com a mesma conta em duas sessões (por exemplo, computador e celular). Cadastre um cliente e uma venda no primeiro dispositivo; confirme que aparecem no segundo. Registre um pagamento no segundo e confirme sua atualização no primeiro. Repita com o segundo dispositivo offline e reconecte-o; verifique a fila, o histórico e os relatórios. O build local, isoladamente, não comprova sincronização com um projeto Supabase.

Execute `npm run build` para validar tipos e gerar a versão de produção. Para publicar a PWA, hospede o conteúdo de `dist` em HTTPS e configure as variáveis de ambiente de produção.
