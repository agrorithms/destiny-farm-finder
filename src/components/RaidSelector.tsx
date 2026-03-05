'use client';

import { useEffect, useState } from 'react';

interface Raid {
    key: string;
    name: string;
    slug: string;
}

interface RaidSelectorProps {
    value: string;
    onChange: (value: string) => void;
    includeAll?: boolean;
}

export default function RaidSelector({
    value,
    onChange,
    includeAll = true,
}: RaidSelectorProps) {
    const [raids, setRaids] = useState<Raid[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/raids')
            .then((res) => res.json())
            .then((data) => {
                setRaids(data.raids || []);
                setLoading(false);
            })
            .catch((err) => {
                console.error('Failed to fetch raids:', err);
                setLoading(false);
            });
    }, []);

    if (loading) {
        return (
            <div className="h-10 w-64 bg-gray-700 rounded animate-pulse" />
        );
    }

    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="bg-gray-800 text-white border border-gray-600 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
            {includeAll && <option value="all">All Raids</option>}
            {raids.map((raid) => (
                <option key={raid.key} value={raid.key}>
                    {raid.name}
                </option>
            ))}
        </select>
    );
}
