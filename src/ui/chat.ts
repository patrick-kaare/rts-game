import { CHAT_HISTORY, MAX_CHAT, type ChatMsg } from '../net/protocol';

/** In game, lines fade out this long after they arrive. */
const FADE_MS = 10_000;

/**
 * Chat panel. In the lobby it is a static panel with the input always shown;
 * in game it floats over the map, lines fade after a while, and the input
 * only appears while open (Enter / Shift+Enter, see Input).
 */
export class ChatBox {
  readonly el = document.createElement('div');
  /** Send to allies only. Can only be on when `canAllies`. */
  allies = false;
  onSend?: (text: string, allies: boolean) => void;
  private list = document.createElement('div');
  private form = document.createElement('div');
  private target = document.createElement('button');
  private input = document.createElement('input');
  private canAlliesValue = false;

  constructor(
    private mode: 'lobby' | 'game',
    /** CSS colour for the sender's name. */
    private colorOf: (msg: ChatMsg) => string,
  ) {
    this.el.className = `chat ${mode}`;
    this.el.hidden = true;
    this.list.className = 'chat-lines';
    this.form.className = 'chat-form';
    this.target.className = 'chat-target';
    this.target.type = 'button';
    this.target.title = 'Tab switches between everyone and allies';
    this.target.addEventListener('mousedown', (ev) => ev.preventDefault());
    this.target.addEventListener('click', () => this.toggleTarget());
    this.input.maxLength = MAX_CHAT;
    this.input.spellcheck = false;
    this.input.placeholder = mode === 'lobby' ? 'Say something…' : '';
    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
    if (mode === 'game') this.input.addEventListener('blur', () => this.close());
    this.form.append(this.target, this.input);
    this.form.hidden = mode === 'game';
    this.el.append(this.list, this.form);
    this.updateTarget();
  }

  get canAllies(): boolean {
    return this.canAlliesValue;
  }

  /** Whether we are on a team; allies-only chat needs one. */
  set canAllies(v: boolean) {
    this.canAlliesValue = v;
    if (!v) this.allies = false;
    this.updateTarget();
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  show(visible: boolean) {
    if (this.el.hidden !== visible) return;
    this.el.hidden = !visible;
    if (!visible) this.close();
  }

  /** Replace all lines. In game, earlier lines start out faded. */
  setMessages(msgs: ChatMsg[]) {
    this.list.innerHTML = '';
    for (const m of msgs) this.line(m, false);
  }

  add(msg: ChatMsg) {
    this.line(msg, true);
  }

  clear() {
    this.list.innerHTML = '';
    this.input.value = '';
  }

  /** Game mode: show the input and history. */
  open(allies: boolean) {
    if (this.el.hidden) return;
    this.allies = allies && this.canAllies;
    this.updateTarget();
    this.el.classList.add('open');
    this.form.hidden = false;
    this.input.focus();
    this.list.scrollTop = this.list.scrollHeight;
  }

  /** Game mode: hide the input again. Keeps the draft. */
  close() {
    if (this.mode !== 'game' || !this.isOpen) return;
    this.el.classList.remove('open');
    this.form.hidden = true;
    this.input.blur();
    this.list.scrollTop = this.list.scrollHeight;
  }

  private onKey(ev: KeyboardEvent) {
    // The game's own key handling must not see what is typed here.
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const text = this.input.value.trim();
      this.input.value = '';
      if (text) this.onSend?.(text, this.allies);
      this.close();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.input.value = '';
      if (this.mode === 'game') this.close();
      else this.input.blur();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      this.toggleTarget();
    }
  }

  private toggleTarget() {
    if (!this.canAllies) return;
    this.allies = !this.allies;
    this.updateTarget();
  }

  private updateTarget() {
    this.target.textContent = this.allies ? 'Allies' : 'All';
    this.target.classList.toggle('allies', this.allies);
    this.target.disabled = !this.canAllies;
  }

  private line(msg: ChatMsg, fresh: boolean) {
    const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    const row = document.createElement('div');
    row.className = 'chat-line';
    if (msg.allies) {
      row.classList.add('allies');
      const tag = document.createElement('em');
      tag.textContent = '(allies) ';
      row.append(tag);
    }
    const name = document.createElement('b');
    name.textContent = `${msg.name}: `;
    name.style.color = this.colorOf(msg);
    row.append(name, document.createTextNode(msg.text));
    if (this.mode === 'game') {
      if (fresh) setTimeout(() => row.classList.add('old'), FADE_MS);
      else row.classList.add('old');
    }
    this.list.append(row);
    while (this.list.childElementCount > CHAT_HISTORY) this.list.firstElementChild!.remove();
    if (atBottom || fresh) this.list.scrollTop = this.list.scrollHeight;
  }
}
