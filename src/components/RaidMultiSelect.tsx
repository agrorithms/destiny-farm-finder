'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface RaidOption {
    key: string;
    name: string;
}

interface RaidMultiSelectProps {
    raids: RaidOption[];
    selected: string[];
    onChange: (selected: string[]) => void;
}

export default function RaidMultiSelect({ raids, selected, onChange }: RaidMultiSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listboxRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => {
        setIsOpen(false);
        setFocusedIndex(-1);
        triggerRef.current?.focus();
    }, []);

    const open = useCallback(() => {
        setIsOpen(true);
        setFocusedIndex(0);
    }, []);

    useEffect(() => {
        if (isOpen && listboxRef.current) {
            listboxRef.current.focus();
        }
    }, [isOpen]);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
                setFocusedIndex(-1);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Close the dropdown when Tab leaves it entirely
    useEffect(() => {
        if (!isOpen) return;
        function handleFocusOut(event: FocusEvent) {
            // A null relatedTarget means focus went nowhere, not that it left the
            // dropdown. WebKit does not focus a <button> on tap, and Chrome and Edge
            // on iOS are both WKWebView, so tapping Select All or Clear Filter blurred
            // the listbox with no relatedTarget. Closing here unmounted the button
            // before its click dispatched: the dropdown shut and nothing was selected.
            //
            // Preventing default on the buttons' mousedown would also stop the blur,
            // but chromium focuses buttons on tap and so cannot test it — one fix that
            // a test can prove beats two where only one is verifiable.
            //
            // Deliberate consequence: focus leaving the window no longer closes the
            // dropdown. Click-outside and Escape still dismiss it.
            if (!event.relatedTarget) return;
            if (dropdownRef.current && !dropdownRef.current.contains(event.relatedTarget as Node)) {
                setIsOpen(false);
                setFocusedIndex(-1);
            }
        }
        const el = dropdownRef.current;
        el?.addEventListener('focusout', handleFocusOut);
        return () => el?.removeEventListener('focusout', handleFocusOut);
    }, [isOpen]);

    function toggleRaid(raidKey: string) {
        if (selected.includes(raidKey)) {
            onChange(selected.filter((k) => k !== raidKey));
        } else {
            onChange([...selected, raidKey]);
        }
    }

    function selectAll() {
        onChange(raids.map((r) => r.key));
    }

    function clearFilter() {
        onChange([]);
    }

    function handleTriggerKeyDown(event: React.KeyboardEvent) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open();
        }
    }

    function handleListboxKeyDown(event: React.KeyboardEvent) {
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                setFocusedIndex((i) => Math.min(i + 1, raids.length - 1));
                break;
            case 'ArrowUp':
                event.preventDefault();
                setFocusedIndex((i) => Math.max(i - 1, 0));
                break;
            case ' ':
                event.preventDefault();
                if (focusedIndex >= 0 && focusedIndex < raids.length) {
                    toggleRaid(raids[focusedIndex].key);
                }
                break;
            case 'Escape':
                event.preventDefault();
                close();
                break;
        }
    }

    // Scroll the focused option into view
    useEffect(() => {
        if (!isOpen || focusedIndex < 0) return;
        const optionId = `raid-option-${raids[focusedIndex]?.key}`;
        document.getElementById(optionId)?.scrollIntoView({ block: 'nearest' });
    }, [focusedIndex, isOpen, raids]);

    let label: string;
    if (selected.length === 0 || selected.length === raids.length) {
        label = 'All Raids';
    } else if (selected.length === 1) {
        const raid = raids.find((r) => r.key === selected[0]);
        label = raid?.name || selected[0];
    } else {
        label = `${selected.length} Raids Selected`;
    }

    const activeDescendant = focusedIndex >= 0 && focusedIndex < raids.length
        ? `raid-option-${raids[focusedIndex].key}`
        : undefined;

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                ref={triggerRef}
                onClick={() => (isOpen ? close() : open())}
                onKeyDown={handleTriggerKeyDown}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                className="flex items-center justify-between gap-2 w-full min-w-[220px] px-3 py-2 ui-input rounded-lg text-sm hover:border-[var(--ui-border-strong)] transition-colors"
            >
                <span className="truncate">{label}</span>
                <svg
                    className={`w-4 h-4 ui-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute z-50 mt-1 w-full min-w-[260px] ui-input rounded-lg shadow-xl overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b ui-divider">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                selectAll();
                            }}
                            className="text-xs ui-accent-text transition-colors"
                        >
                            Select All
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                clearFilter();
                            }}
                            className="text-xs text-gray-600 hover:text-gray-800 transition-colors dark:text-gray-400 dark:hover:text-gray-300"
                        >
                            Clear Filter
                        </button>
                    </div>

                    <div
                        ref={listboxRef}
                        role="listbox"
                        aria-multiselectable="true"
                        aria-activedescendant={activeDescendant}
                        tabIndex={0}
                        onKeyDown={handleListboxKeyDown}
                        className="max-h-[300px] overflow-y-auto outline-none"
                    >
                        {raids.map((raid, index) => {
                            const isSelected = selected.includes(raid.key);
                            const isFocused = index === focusedIndex;
                            return (
                                <div
                                    key={raid.key}
                                    id={`raid-option-${raid.key}`}
                                    role="option"
                                    aria-selected={isSelected}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleRaid(raid.key);
                                        setFocusedIndex(index);
                                        listboxRef.current?.focus();
                                    }}
                                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer ui-list-item-hover select-none ${isSelected ? 'ui-list-item-active' : ''
                                        } ${isFocused ? 'ring-2 ring-inset ring-[var(--ui-accent)]' : ''}`}
                                >
                                    <div
                                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected
                                                ? 'ui-check-selected'
                                                : 'border-[var(--ui-text-subtle)] bg-transparent'
                                            }`}
                                    >
                                        {isSelected && (
                                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                            </svg>
                                        )}
                                    </div>
                                    <span className="text-sm ui-text-primary">{raid.name}</span>
                                </div>
                            );
                        })}
                    </div>

                    <div className="px-3 py-2 border-t ui-divider text-xs ui-text-muted">
                        {selected.length === 0
                            ? 'No filter — showing all raids'
                            : `${selected.length} of ${raids.length} raids selected`}
                    </div>
                </div>
            )}
        </div>
    );
}
