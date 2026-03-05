'use client';

interface TimeSliderProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
}

export default function TimeSlider({
    value,
    onChange,
    min = 1,
    max = 8,
    step = 0.5,
}: TimeSliderProps) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-300">
                    Time Window
                </label>
                <span className="text-sm font-bold text-white">
                    Last {value} {value === 1 ? 'hour' : 'hours'}
                </span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-500">
                <span>{min}h</span>
                <span>{max}h</span>
            </div>
        </div>
    );
}
