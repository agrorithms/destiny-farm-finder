'use client';

import { useState, useRef, useEffect } from 'react';

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
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

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

    function clearAll() {
        onChange([]);
    }

    // Build display label
    let label: string;
    if (selected.length === 0 || selected.length === raids.length) {
        label = 'All Raids';
    } else if (selected.length === 1) {
        const raid = raids.find((r) => r.key === selected[0]);
        label = raid?.name || selected[0];
    } else {
        label = `${selected.length} Raids Selected`;
    }

    return (
        <div className="relative" ref={dropdownRef}>
            {/* Trigger Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center justify-between gap-2 w-full min-w-[220px] px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-gray-200 hover:border-gray-500 transition-colors"
            >
                <span className="truncate">{label}</span>
                <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {/* Dropdown Panel */}
            {isOpen && (
                <div className="absolute z-50 mt-1 w-full min-w-[260px] bg-gray-800 border border-gray-600 rounded-lg shadow-xl overflow-hidden">
                    {/* Select All / Clear All */}
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                selectAll();
                            }}
                            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                            Select All
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                clearAll();
                            }}
                            className="text-xs text-gray-400 hover:text-gray-300 transition-colors"
                        >
                            Clear All
                        </button>
                    </div>

                    {/* Raid Options */}
                    <div className="max-h-[300px] overflow-y-auto">
                        {raids.map((raid) => {
                            const isSelected = selected.includes(raid.key);
                            return (
                                <div
                                    key={raid.key}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleRaid(raid.key);
                                    }}
                                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-700/50 transition-colors select-none ${isSelected ? 'bg-gray-700/30' : ''
                                        }`}
                                >
                                    <div
                                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected
                                                ? 'bg-blue-500 border-blue-500'
                                                : 'border-gray-500 bg-transparent'
                                            }`}
                                    >
                                        {isSelected && (
                                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                            </svg>
                                        )}
                                    </div>
                                    <span className="text-sm text-gray-200">{raid.name}</span>
                                </div>
                            );
                        })}
                    </div>

                    {/* Selected count footer */}
                    <div className="px-3 py-2 border-t border-gray-700 text-xs text-gray-500">
                        {selected.length === 0
                            ? 'No filter — showing all raids'
                            : `${selected.length} of ${raids.length} raids selected`}
                    </div>
                </div>
            )}
        </div>
    );
}
