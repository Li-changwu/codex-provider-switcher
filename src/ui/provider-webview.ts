import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import type { ProviderWorkbenchController } from "./provider-workbench";

export interface ProviderWebviewPanelApi {
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: vscode.ViewColumn,
    options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
  ): vscode.WebviewPanel;
}

export class ProviderWorkbenchPanel {
  private panel: vscode.WebviewPanel | undefined;
  private requestedProfileId: string | undefined;
  private createRequested = false;

  constructor(
    private readonly api: ProviderWebviewPanelApi,
    private readonly viewColumn: vscode.ViewColumn,
    private readonly controller: ProviderWorkbenchController,
  ) {}

  open(profileId?: string): void {
    this.requestedProfileId = profileId;
    this.createRequested = false;
    this.ensurePanel();
    this.panel?.reveal(this.viewColumn, true);
    void this.publishInitialState();
  }

  openCreate(): void {
    this.createRequested = true;
    this.ensurePanel();
    this.panel?.reveal(this.viewColumn, true);
    void this.panel?.webview.postMessage({ type: "showCreate" });
  }

  postProgress(event: unknown): void {
    void this.panel?.webview.postMessage({ type: "operationProgress", event });
  }

  refresh(): void {
    if (this.panel) {
      void this.publishInitialState();
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    const panel = this.api.createWebviewPanel(
      "codexProvider.workbench",
      "Codex Provider",
      this.viewColumn,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.webview.html = createProviderWorkbenchHtml(createNonce());
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isRecord(message) && message.type === "ready") {
        await this.publishInitialState();
        return;
      }
      try {
        const result = await this.controller.handleMessage(message);
        await panel.webview.postMessage(result);
        if (isRecord(result) && ["operationCompleted", "operationCancelled"].includes(String(result.type))) {
          await this.publishInitialState();
        }
      } catch (error: unknown) {
        await panel.webview.postMessage({
          type: "operationFailed",
          message: error instanceof Error ? error.message : "The Provider operation failed.",
        });
      }
    });
  }

  private async publishInitialState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const profileList = await this.controller.handleMessage({ type: "listProfiles" });
    await this.panel.webview.postMessage(profileList);
    const requested = this.requestedProfileId
      ?? (isRecord(profileList) && typeof profileList.activeProfileId === "string"
        ? profileList.activeProfileId
        : undefined);
    if (requested) {
      await this.panel.webview.postMessage(
        await this.controller.handleMessage({ type: "loadProfile", profileId: requested }),
      );
      await this.panel.webview.postMessage(
        await this.controller.handleMessage({ type: "listSessions", profileId: requested }),
      );
    }
    if (this.createRequested) {
      this.createRequested = false;
      await this.panel.webview.postMessage({ type: "showCreate" });
    }
  }
}

export function createProviderWorkbenchHtml(nonce: string): string {
  const safeNonce = escapeAttribute(nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${safeNonce}">
    *{box-sizing:border-box} body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:13px} button,input,select,textarea{font:inherit} button{border:1px solid transparent;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer} button:hover{background:var(--vscode-button-hoverBackground)} button.secondary{color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground)} button.icon{width:30px;height:30px;padding:0;font-size:17px} button:disabled{opacity:.45;cursor:not-allowed} input,select,textarea{width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:6px 8px;outline:none} input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)} textarea{min-height:280px;resize:vertical;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)} .shell{min-height:100vh}.topbar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border)} .topbar select{max-width:280px}.spacer{flex:1}.content{max-width:1000px;margin:0 auto;padding:22px 24px}.heading{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}.heading h1{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:0}.muted{color:var(--vscode-descriptionForeground)} .badge{display:inline-block;padding:2px 7px;border:1px solid var(--vscode-panel-border);font-size:11px}.badge.active{color:var(--vscode-testing-iconPassed);border-color:var(--vscode-testing-iconPassed)} .actions{display:flex;gap:7px;flex-wrap:wrap}.tabs{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border);margin-top:20px}.tab{color:var(--vscode-foreground);background:transparent;border-bottom:2px solid transparent}.tab.active{border-bottom-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)} section{display:none;padding:20px 0} section.active{display:block}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;max-width:760px}.field.full{grid-column:1/-1}.field label{display:block;margin-bottom:5px;font-size:12px;color:var(--vscode-descriptionForeground)}.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px}.status{min-height:36px;padding:9px 0;color:var(--vscode-descriptionForeground)}.status.error{color:var(--vscode-errorForeground)} progress{width:100%;height:6px;border:0}.session{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}.session-id{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}.empty{padding:48px 0;text-align:center;color:var(--vscode-descriptionForeground)}dialog{width:min(620px,calc(100vw - 32px));color:var(--vscode-foreground);background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);padding:20px}dialog::backdrop{background:#0008}dialog h2{margin-top:0;font-size:18px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.official-note{padding:12px 0;color:var(--vscode-descriptionForeground)}@media(max-width:620px){.content{padding:16px}.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.topbar{flex-wrap:wrap}.topbar select{max-width:none;flex:1 1 180px}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar"><select id="profileSelect" aria-label="Provider"></select><button id="add" class="icon" title="Add Provider" aria-label="Add Provider">+</button><button id="refresh" class="icon secondary" title="Refresh" aria-label="Refresh">↻</button><span class="spacer"></span><span id="globalStatus" class="muted"></span></div>
    <main class="content">
      <div id="empty" class="empty">Add a Provider to start managing Codex configuration.</div>
      <div id="workspace" hidden>
        <div class="heading"><div><h1 id="profileName"></h1><div id="profileKind" class="muted"></div></div><span id="activeBadge" class="badge"></span><span class="spacer"></span><div class="actions"><button id="switch">Switch</button><button id="delete" class="secondary">Delete</button></div></div>
        <div class="tabs" role="tablist"><button class="tab active" data-tab="configuration">Provider configuration</button><button class="tab" data-tab="configRaw">config.toml</button><button class="tab" data-tab="authRaw">auth.json</button><button class="tab" data-tab="sessions">Sessions</button></div>
        <section id="configuration" class="active"><div id="officialNote" hidden><div class="official-note">OpenAI official authentication is completed through the native Codex login flow when this Provider is switched or synchronized.</div><div class="form-grid"><div class="field full"><label for="officialName">Display name</label><input id="officialName"></div><div class="field full"><button id="saveOfficial">Save official Provider</button></div></div></div><div id="customForm" class="form-grid"><div class="field full"><label for="editName">Display name</label><input id="editName"></div><div class="field"><label for="providerId">Provider ID</label><input id="providerId"></div><div class="field"><label for="wireApi">Wire API</label><select id="wireApi"><option value="responses">responses</option></select></div><div class="field full"><label for="baseUrl">Base URL</label><input id="baseUrl" type="url"></div><div class="field full"><label for="replacementKey">Replacement API key (optional)</label><input id="replacementKey" type="password" autocomplete="new-password"></div><div class="field full"><button id="save">Save Provider</button></div></div></section>
        <section id="configRaw"><div class="toolbar"><span class="muted">Validated before saving</span><span class="spacer"></span><button id="saveRaw">Save config.toml</button></div><textarea id="configText" spellcheck="false" aria-label="config.toml"></textarea></section>
        <section id="authRaw"><div class="toolbar"><span class="muted">Credentials are write-only and stored in VS Code SecretStorage.</span><span class="spacer"></span><button id="saveAuth">Save auth.json</button></div><textarea id="authText" spellcheck="false" aria-label="auth.json"></textarea></section>
        <section id="sessions"><div class="toolbar"><button id="sync">Sync session metadata</button><span class="muted">Sync runs only when you click this button.</span></div><progress id="progress" max="100" value="0"></progress><div id="syncStatus" class="status" aria-live="polite">Continue is enabled after a successful synchronization. No session metadata needs synchronization when all records already match.</div><div id="sessionList"></div></section>
      </div>
    </main>
  </div>
  <dialog id="createDialog"><form method="dialog"><h2>Add Provider</h2><div class="form-grid"><div class="field full"><label for="newName">Display name</label><input id="newName" required></div><div class="field full"><label for="newKind">Type</label><select id="newKind"><option value="custom">Custom configuration</option><option value="official">OpenAI official login</option></select></div><div id="newCustom" class="field full"><label for="newConfig">config.toml</label><textarea id="newConfig" spellcheck="false">model_provider = "custom"
[model_providers.custom]
name = "Custom Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
</textarea><label for="newKey">API key</label><input id="newKey" type="password" autocomplete="new-password"></div></div><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button id="create" value="default">Create</button></div></form></dialog>
  <script nonce="${safeNonce}">
    const vscode = acquireVsCodeApi();
    const state = { profile: null, profiles: [], sessions: [] };
    const byId = (id) => document.getElementById(id);
    function post(message){ vscode.postMessage(message); }
    function setStatus(message,error){ byId('globalStatus').textContent=message||''; byId('syncStatus').textContent=message||''; byId('syncStatus').className='status'+(error?' error':''); }
    function selectTab(id){ document.querySelectorAll('.tab').forEach((el)=>el.classList.toggle('active',el.dataset.tab===id)); document.querySelectorAll('main section').forEach((el)=>el.classList.toggle('active',el.id===id)); }
    function updateProfileList(message){ state.profiles=message.profiles||[]; const select=byId('profileSelect'); select.replaceChildren(); state.profiles.forEach((profile)=>{ const option=document.createElement('option'); option.value=profile.id; option.textContent=profile.name+(profile.active?' (Active)':''); select.append(option); }); if(state.profile)select.value=state.profile.id; byId('empty').hidden=state.profiles.length>0; }
    function parseStructured(text,profile){ const provider=(text.match(/^model_provider\\s*=\\s*"([^"]+)"/m)||[])[1]||profile.providerId||''; const base=(text.match(/^base_url\\s*=\\s*"([^"]+)"/m)||[])[1]||''; const wire=(text.match(/^wire_api\\s*=\\s*"([^"]+)"/m)||[])[1]||'responses'; return {provider,base,wire}; }
    function renderProfile(message){ state.profile=message.profile; byId('workspace').hidden=false; byId('empty').hidden=true; byId('profileSelect').value=message.profile.id; byId('profileName').textContent=message.profile.name; byId('profileKind').textContent=message.profile.kind==='official'?'OpenAI official login':'Custom configuration'; byId('activeBadge').textContent=message.active?'Active':'Inactive'; byId('activeBadge').className='badge'+(message.active?' active':''); byId('switch').disabled=message.active; byId('delete').disabled=message.active; byId('editName').value=message.profile.name; byId('officialName').value=message.profile.name; byId('configText').value=message.configText||''; byId('authText').value=message.auth.json||''; const custom=message.profile.kind==='custom'; byId('customForm').hidden=!custom; byId('officialNote').hidden=custom; document.querySelector('[data-tab="configRaw"]').hidden=!custom; document.querySelector('[data-tab="authRaw"]').hidden=!custom; const fields=parseStructured(message.configText||'',message.profile); byId('providerId').value=fields.provider; byId('baseUrl').value=fields.base; byId('wireApi').value=fields.wire; }
    function structuredConfig(){ let text=byId('configText').value; const old=(text.match(/^model_provider\\s*=\\s*"([^"]+)"/m)||[])[1]||byId('providerId').value; const next=byId('providerId').value.trim(); const safeOld=old.replace(/[^A-Za-z0-9_-]/g,''); text=text.replace(/^model_provider\\s*=.*$/m,'model_provider = "'+next+'"').replace(new RegExp('^\\[model_providers\\.'+safeOld+'\\]$','m'),'[model_providers.'+next+']').replace(/^base_url\\s*=.*$/m,'base_url = "'+byId('baseUrl').value.trim()+'"').replace(/^wire_api\\s*=.*$/m,'wire_api = "responses"'); return text; }
    function renderSessions(message){ state.sessions=message.sessions||[]; const list=byId('sessionList'); list.replaceChildren(); state.sessions.forEach((session)=>{ const row=document.createElement('div'); row.className='session'; const label=document.createElement('div'); label.className='session-id'; label.textContent=session.sessionId; const button=document.createElement('button'); button.textContent='Continue'; button.disabled=!session.canContinue; button.title=session.disabledReason||'Continue this Codex session'; button.addEventListener('click',()=>post({type:'continueSession',profileId:state.profile.id,sessionId:session.sessionId})); row.append(label,button); list.append(row); }); }
    window.addEventListener('message',(event)=>{ const message=event.data||{}; if(message.type==='profileList')updateProfileList(message); else if(message.type==='profileSnapshot')renderProfile(message); else if(message.type==='sessionSnapshot')renderSessions(message); else if(message.type==='showCreate')byId('createDialog').showModal(); else if(message.type==='operationProgress'){ const p=message.event&&message.event.percentage; if(Number.isFinite(p))byId('progress').value=p; else byId('progress').removeAttribute('value'); setStatus(message.event&&message.event.stage?'Working: '+message.event.stage:'Working…'); } else if(message.type==='operationCompleted'){ byId('progress').value=100; setStatus(message.message||'Operation completed.'); if(state.profile)post({type:'listSessions',profileId:state.profile.id}); } else if(message.type==='continuationCompleted'){ setStatus(message.mode==='fork'?'Created branch '+(message.branchSessionId||'')+'.':'Codex resume started.'); } else if(message.type==='operationFailed')setStatus(message.message||'Operation failed.',true); });
    document.querySelectorAll('.tab').forEach((el)=>el.addEventListener('click',()=>selectTab(el.dataset.tab)));
    byId('profileSelect').addEventListener('change',()=>{ post({type:'loadProfile',profileId:byId('profileSelect').value}); post({type:'listSessions',profileId:byId('profileSelect').value}); });
    byId('add').addEventListener('click',()=>byId('createDialog').showModal()); byId('refresh').addEventListener('click',()=>post({type:'listProfiles'})); byId('newKind').addEventListener('change',()=>byId('newCustom').hidden=byId('newKind').value==='official');
    byId('create').addEventListener('click',(event)=>{ event.preventDefault(); const kind=byId('newKind').value; post({type:'createProfile',name:byId('newName').value,kind,configText:kind==='custom'?byId('newConfig').value:undefined,apiKey:kind==='custom'?byId('newKey').value:undefined}); byId('createDialog').close(); });
    byId('switch').addEventListener('click',()=>post({type:'switchProfile',profileId:state.profile.id})); byId('delete').addEventListener('click',()=>post({type:'deleteProfile',profileId:state.profile.id})); byId('sync').addEventListener('click',()=>{ byId('progress').value=0; post({type:'syncSessions',profileId:state.profile.id}); });
    function save(configText,apiKey){ post({type:'saveProfile',profileId:state.profile.id,name:byId('editName').value,configText,apiKey}); }
    byId('save').addEventListener('click',()=>{ const text=structuredConfig(); byId('configText').value=text; save(text,byId('replacementKey').value||undefined); }); byId('saveOfficial').addEventListener('click',()=>post({type:'saveProfile',profileId:state.profile.id,name:byId('officialName').value,configText:byId('configText').value})); byId('saveRaw').addEventListener('click',()=>save(byId('configText').value,undefined)); byId('saveAuth').addEventListener('click',()=>{ try{ const auth=JSON.parse(byId('authText').value); const key=auth.OPENAI_API_KEY; if(typeof key!=='string'||!key.trim()||key==='[REDACTED]')throw new Error('Enter a replacement OPENAI_API_KEY before saving.'); save(byId('configText').value,key); }catch(error){setStatus(error.message||'auth.json is invalid.',true);} });
    post({type:'ready'});
  </script>
</body>
</html>`;
}

function createNonce(): string {
  return randomBytes(16).toString("base64url");
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
