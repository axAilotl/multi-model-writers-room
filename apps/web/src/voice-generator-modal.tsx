import { Bot, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DefaultModelSelection,
  VoiceTemplateInput
} from "@writers-room/contracts";
import { api } from "./api.js";
import { providerLabels } from "./provider-labels.js";

export function VoiceGeneratorModal({
  defaultModel,
  onClose,
  onGenerated
}: {
  defaultModel?: DefaultModelSelection;
  onClose: () => void;
  onGenerated: (template: VoiceTemplateInput) => void;
}) {
  const [name, setName] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    nameRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setGenerating(true);
    setError(undefined);
    try {
      onGenerated(await api.generateVoiceTemplate({ name, sourceText }));
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div
      className="modal-backdrop settings-modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="agent-modal voice-generator-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-generator-title"
        onSubmit={submit}
      >
        <header>
          <div id="voice-generator-title">
            <Sparkles size={18} /> Generate a voice template
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close voice generator"
          >
            <X size={16} />
          </button>
        </header>
        <p className="generator-intro">
          Give the voice a name and paste the material that should shape its expertise,
          priorities, and style. You can edit the generated draft before saving it.
        </p>
        <div className="generator-model-note">
          <Bot size={15} />
          {defaultModel ? (
            <span>
              Uses the default fallback · {providerLabels[defaultModel.provider]} / {defaultModel.modelId}
            </span>
          ) : (
            <span>Choose a default fallback model under Providers & models first.</span>
          )}
        </div>
        <label>Voice name
          <input
            ref={nameRef}
            name="generatedVoiceName"
            required
            maxLength={80}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Product Heretic"
          />
        </label>
        <label>Source material
          <textarea
            name="voiceSourceText"
            required
            minLength={20}
            maxLength={30_000}
            rows={11}
            value={sourceText}
            onChange={event => setSourceText(event.target.value)}
            placeholder="Paste a role description, manifesto, writing sample, research brief, or any block of text that should define this voice…"
          />
        </label>
        {error && <div className="settings-error">{error}</div>}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={generating || !name.trim() || sourceText.trim().length < 20}
          >
            {generating
              ? <LoaderCircle size={15} className="spin" />
              : <Sparkles size={15} />}
            Generate editable draft
          </button>
        </footer>
      </form>
    </div>
  );
}
