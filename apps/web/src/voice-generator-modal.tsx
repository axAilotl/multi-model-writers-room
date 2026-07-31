import { Bot, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DefaultModelSelection,
  VoiceTemplateInput
} from "@writers-room/contracts";
import { api } from "./api.js";
import { providerLabels } from "./provider-labels.js";
import { useModalFocus } from "./use-modal-focus.js";

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
  const activeRequestRef = useRef<AbortController | undefined>(undefined);
  const {
    dialogRef,
    initialFocusRef: nameRef
  } = useModalFocus<HTMLFormElement, HTMLInputElement>({ onClose });

  useEffect(() => () => {
    activeRequestRef.current?.abort();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setGenerating(true);
    setError(undefined);
    try {
      const template = await api.generateVoiceTemplate(
        { name, sourceText },
        controller.signal
      );
      if (!controller.signal.aborted) onGenerated(template);
    } catch (errorValue) {
      if (!controller.signal.aborted) {
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      }
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = undefined;
      }
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
            disabled={
              generating ||
              defaultModel === undefined ||
              !name.trim() ||
              sourceText.trim().length < 20
            }
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
