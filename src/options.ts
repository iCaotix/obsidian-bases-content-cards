import type { BasesAllOptions } from 'obsidian';

import { UNLIMITED } from './params.ts';

/** What the view shows in the Bases options panel. Read back in `readParams()`. */
export function viewOptions(): BasesAllOptions[] {
	return [
		{
			type: 'text',
			key: 'coverSelector',
			displayName: 'Cover',
			default: ':',
			placeholder: ': or #Heading or ^block-id',
		},
		{
			type: 'property',
			key: 'selectorProperty',
			displayName: 'Cover override property',
			placeholder: 'Property holding a per-note cover',
		},
		{
			type: 'slider',
			key: 'maxLength',
			displayName: 'Cover length',
			default: 300,
			min: 80,
			max: 1200,
			step: 20,
		},
		{
			type: 'toggle',
			key: 'renderMarkdown',
			displayName: 'Render markdown',
			default: false,
		},
		{
			type: 'toggle',
			key: 'wrapTitle',
			displayName: 'Wrap long titles',
			default: false,
		},
		{
			type: 'dropdown',
			key: 'cardSize',
			displayName: 'Card height',
			default: 'auto',
			options: {
				auto: 'Fit to content',
				uniform: 'Uniform',
			},
		},
		{
			type: 'toggle',
			key: 'openInNewTab',
			displayName: 'Open notes in a new tab',
			default: false,
		},
		{
			type: 'dropdown',
			key: 'cardTint',
			displayName: 'Card tint',
			default: 'off',
			options: {
				off: 'None',
				subtle: 'Subtle',
				strong: 'Strong',
			},
		},
		{
			type: 'dropdown',
			key: 'maxSize',
			displayName: 'Maximum card height',
			default: 'l',
			options: {
				s: 'Small',
				m: 'Medium',
				l: 'Large',
				xl: 'Extra large',
				[UNLIMITED]: 'Unlimited',
			},
		},
	];
}
