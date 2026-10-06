'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

export interface UsePushToTalkOptions {
  onTranscriptComplete?: (transcript: string) => void;
  language?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
}

export function usePushToTalk(options: UsePushToTalkOptions = {}) {
  const [state, setState] = useState<VoiceState>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const synthUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const isHoldingKeyRef = useRef(false);

  const lang = options.language || 'en-IN';

  // Initialize Speech Recognition
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const windowWithSpeech = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };

    const SpeechRecognition =
      windowWithSpeech.SpeechRecognition || windowWithSpeech.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item && item.isFinal && item[0]) {
          final += item[0].transcript;
        } else if (item && item[0]) {
          interim += item[0].transcript;
        }
      }

      if (interim) setInterimTranscript(interim);
      if (final) {
        setFinalTranscript((prev) => (prev ? `${prev} ${final}` : final));
        setInterimTranscript('');
      }
    };

    recognition.onerror = (event: { error: string }) => {
      console.warn('Speech recognition error:', event.error);
      if (event.error === 'no-speech') {
        // User stayed silent, no critical error
        return;
      }
      setErrorMessage(`Microphone error: ${event.error}`);
      setState('error');
    };

    recognition.onend = () => {
      // Stopped listening
      if (state === 'listening') {
        setState('idle');
      }
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.abort();
      } catch {
        // Safe cleanup ignore
      }
    };
  }, [lang, state]);

  // Clean up Audio Context on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  /**
   * Start microphone audio stream and speech recognition
   */
  const startListening = useCallback(async () => {
    try {
      setErrorMessage(null);
      setInterimTranscript('');
      setFinalTranscript('');

      // Stop any active speech synthesis
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }

      // Initialize Web Audio API Analyser for live waveforms
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        const windowWithAudio = window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const AudioCtx = windowWithAudio.AudioContext || windowWithAudio.webkitAudioContext;
        if (AudioCtx) {
          audioContextRef.current = new AudioCtx();
        }
      }

      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      if (!mediaStreamRef.current || !mediaStreamRef.current.active) {
        mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      if (audioContextRef.current && mediaStreamRef.current) {
        const source = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyserRef.current = analyser;
      }

      // Start recognition
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch {
          // Already running
        }
      }

      setState('listening');
    } catch (err: unknown) {
      console.error('Failed to start microphone:', err);
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      setErrorMessage(msg);
      setState('error');
    }
  }, []);

  /**
   * Stop listening and trigger processing with final transcript
   */
  const stopListening = useCallback(() => {
    if (state !== 'listening') return;

    setState('processing');

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Recognition already stopped
      }
    }

    // Capture captured text
    const completeText = (finalTranscript + ' ' + interimTranscript).trim();
    if (completeText && options.onTranscriptComplete) {
      options.onTranscriptComplete(completeText);
    } else if (!completeText) {
      setState('idle');
    }
  }, [state, finalTranscript, interimTranscript, options]);

  /**
   * Toggle listening state
   */
  const toggleListening = useCallback(() => {
    if (state === 'listening') {
      stopListening();
    } else if (state === 'idle' || state === 'error') {
      startListening();
    }
  }, [state, startListening, stopListening]);

  /**
   * Speak response aloud with Speech Synthesis API
   */
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    setState('speaking');

    const utterance = new SpeechSynthesisUtterance(text);
    synthUtteranceRef.current = utterance;

    // Pick Indian English voice or standard clear voice
    const voices = window.speechSynthesis.getVoices();
    const inVoice =
      voices.find((v) => v.lang === 'en-IN') ||
      voices.find((v) => v.lang.startsWith('en')) ||
      voices[0];

    if (inVoice) {
      utterance.voice = inVoice;
    }
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      setState('idle');
    };

    utterance.onerror = (e) => {
      console.warn('Speech synthesis error:', e);
      setState('idle');
    };

    window.speechSynthesis.speak(utterance);
  }, []);

  /**
   * Stop active speech synthesis
   */
  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      if (state === 'speaking') {
        setState('idle');
      }
    }
  }, [state]);

  // Global Keyboard shortcuts: Spacebar Push-to-Talk (when not inside an input/textarea)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      if (e.code === 'Space' && !e.repeat && !isHoldingKeyRef.current) {
        e.preventDefault();
        isHoldingKeyRef.current = true;
        startListening();
      }

      if (e.code === 'Escape') {
        if (state === 'speaking') {
          stopSpeaking();
        } else if (state === 'listening') {
          stopListening();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      if (e.code === 'Space' && isHoldingKeyRef.current) {
        e.preventDefault();
        isHoldingKeyRef.current = false;
        stopListening();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [state, startListening, stopListening, stopSpeaking]);

  return {
    state,
    setState,
    isSupported,
    interimTranscript,
    finalTranscript,
    errorMessage,
    analyserNode: analyserRef.current,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  };
}
