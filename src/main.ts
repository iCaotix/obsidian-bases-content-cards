import { Plugin } from 'obsidian';

import { viewOptions } from './options';
import { CONTENT_CARDS_VIEW, ContentCardsView } from './view';

export default class ContentCardsPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerBasesView(CONTENT_CARDS_VIEW, {
			name: 'Content cards',
			icon: 'lucide-layout-grid',
			factory: (controller, containerEl) => new ContentCardsView(controller, containerEl),
			options: viewOptions,
		});
	}
}
