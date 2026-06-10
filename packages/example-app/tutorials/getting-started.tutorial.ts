import { tutorial, step } from 'tutorial-forge';

export default tutorial('Getting started with Lumen Events', [
  step(
    'Welcome to Lumen Events. In this short tour, we will create your first event and adjust a workspace setting.',
    async () => {
      // Pure-narration step: the dashboard simply stays on screen.
    },
    { id: 'welcome' },
  ),
  step(
    'From the dashboard, open the Events page using the navigation bar.',
    async (page) => {
      await page.getByRole('link', { name: 'Events', exact: true }).click();
      await page.getByRole('heading', { name: 'Events' }).waitFor();
    },
    { id: 'open-events' },
  ),
  step(
    'To add an event, click the New event button. A dialog opens where you can fill in the details.',
    async (page) => {
      await page.getByRole('button', { name: 'New event' }).click();
    },
    { id: 'open-modal' },
  ),
  step(
    'Give the event a descriptive name. This is what attendees will see on their invitations.',
    async (page) => {
      await page.getByLabel('Event name').fill('Summer Kickoff Party');
    },
    { id: 'fill-name' },
  ),
  step(
    'Then pick the event type that best matches the format.',
    async (page) => {
      await page.getByLabel('Event type').selectOption('Workshop');
    },
    { id: 'pick-type' },
  ),
  step(
    'Click Create event. Saving takes a moment, and the new event appears in the list as a draft.',
    async (page) => {
      await page.getByRole('button', { name: 'Create event' }).click();
    },
    {
      id: 'create-event',
      // The fake save takes 1.5s; wait for the success toast, not a timeout.
      waitFor: async (page) => {
        await page.locator('#toast.show').waitFor({ timeout: 5000 });
        await page.getByRole('cell', { name: 'Summer Kickoff Party' }).waitFor();
      },
      settleMs: 800,
    },
  ),
  step(
    'Finally, visit Settings to control reminders and visibility. Here we enable public event pages.',
    async (page) => {
      await page.getByRole('link', { name: 'Settings' }).click();
      await page.getByRole('heading', { name: 'Settings' }).waitFor();
      await page.locator('#public-pages').check();
    },
    { id: 'settings' },
  ),
  step(
    'That is all it takes. Your event is drafted, your workspace is configured, and you are ready to invite attendees.',
    async () => {},
    { id: 'wrap-up' },
  ),
], { id: 'getting-started' });
