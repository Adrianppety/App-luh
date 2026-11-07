# Controle de vendas

Aplicativo web local-first para clientes, vendas e pagamentos de semijoias. Os dados ficam no IndexedDB do navegador; não há conta, backend ou sincronização entre aparelhos.

## Executar

Requer Node.js e npm.

```bash
npm install
npm run dev
```

Para gerar a versão de produção:

```bash
npm run build
npm run preview
```

Publique o conteúdo de `dist/` em um host HTTPS para disponibilizar a instalação e o modo offline. No iPhone, abra o link no Safari, toque em **Compartilhar** e escolha **Adicionar à Tela de Início**. Depois do primeiro carregamento online, o app shell e os recursos necessários ficam em cache para uso offline.

## Dados e backup

O banco IndexedDB é mantido entre atualizações do app. Os dados não são compartilhados entre dispositivos nem incluídos automaticamente no backup do iCloud. Em **Ajustes**, exporte periodicamente o arquivo JSON e guarde-o em um local seguro. Importar um arquivo substitui os dados locais após confirmação.
"# App-luh" 
