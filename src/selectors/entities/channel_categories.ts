// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {createSelector} from 'reselect';
import shallowEquals from 'shallow-equals';

import {General, Preferences} from '../../constants';
import {CategoryTypes} from '../../constants/channel_categories';

import {getCurrentChannelId, getMyChannelMemberships} from 'selectors/entities/channels';
import {getCurrentUserLocale} from 'selectors/entities/i18n';
import {getLastPostPerChannel} from 'selectors/entities/posts';
import {getMyPreferences, getTeammateNameDisplaySetting, shouldAutocloseDMs} from 'selectors/entities/preferences';
import {getCurrentUserId} from 'selectors/entities/users';

import {Channel, ChannelMembership} from 'types/channels';
import {ChannelCategory} from 'types/channel_categories';
import {GlobalState} from 'types/store';
import {UserProfile} from 'types/users';
import {IDMappedObjects, RelationOneToOne} from 'types/utilities';

import {
    getUserIdFromChannelName,
    isChannelMuted,
    isFavoriteChannel,
    isUnreadChannel,
} from 'utils/channel_utils';
import {getPreferenceKey} from 'utils/preference_utils';
import {displayUsername} from 'utils/user_utils';

export function getCategoryIdsForTeam(state: GlobalState, teamId: string): string[] | undefined {
    return state.entities.channelCategories.orderByTeam[teamId];
}

export function makeGetCategoriesForTeam(): (state: GlobalState, teamId: string) => ChannelCategory[] {
    return createSelector(
        getCategoryIdsForTeam,
        (state: GlobalState) => state.entities.channelCategories.byId,
        (categoryIds, categoriesById) => {
            if (!categoryIds) {
                return [];
            }

            return categoryIds.map((id) => categoriesById[id]);
        },
    );
}

export function makeGetUnsortedUnfilteredChannels(): (state: GlobalState, teamId: string) => Channel[] {
    return createSelector(
        (state: GlobalState) => state.entities.channels.channels,
        getCurrentChannelId,
        getMyChannelMemberships,
        (state: GlobalState, teamId: string) => teamId,
        (allChannels: IDMappedObjects<Channel>, currentChannelId: string, myMembers: RelationOneToOne<Channel, ChannelMembership>, teamId: string) => {
            return Object.values(allChannels).
                filter((channel) => channel.delete_at === 0 || channel.id === currentChannelId).
                filter((channel) => channel.team_id === teamId || channel.team_id === '').
                filter((channel) => myMembers.hasOwnProperty(channel.id));
        },
    );
}

export function makeFilterChannelsByFavorites(): (state: GlobalState, channels: Channel[], categoryType: string) => Channel[] {
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        (state: GlobalState, channels: Channel[], categoryType: string) => categoryType,
        getMyPreferences,
        (channels, categoryType, myPreferences) => {
            const filtered = channels.filter((channel) => {
                if (categoryType === CategoryTypes.FAVORITES) {
                    return isFavoriteChannel(myPreferences, channel.id);
                }

                return !isFavoriteChannel(myPreferences, channel.id);
            });

            return filtered.length === channels.length ? channels : filtered;
        },
    );
}

export function makeFilterChannelsByType(): (state: GlobalState, channels: Channel[], categoryType: string) => Channel[] {
    // This doesn't need to be a selector, but make it as one to keep it consistent
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        (state: GlobalState, channels: Channel[], categoryType: string) => categoryType,
        (channels, categoryType) => {
            const filtered = channels.filter((channel) => {
                if (categoryType === CategoryTypes.PUBLIC) {
                    return channel.type === General.OPEN_CHANNEL;
                } else if (categoryType === CategoryTypes.PRIVATE) {
                    return channel.type === General.PRIVATE_CHANNEL;
                } else if (categoryType === CategoryTypes.DIRECT_MESSAGES) {
                    return channel.type === General.DM_CHANNEL || channel.type === General.GM_CHANNEL;
                }

                return true;
            });

            return filtered.length === channels.length ? channels : filtered;
        },
    );
}

function getDefaultAutocloseCutoff() {
    return Date.now() - 7 * 24 * 60 * 60 * 1000;
}

export function makeFilterAutoclosedDMs(getAutocloseCutoff = getDefaultAutocloseCutoff): (state: GlobalState, channels: Channel[], categoryType: string) => Channel[] {
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        (state: GlobalState, channels: Channel[], categoryType: string) => categoryType,
        getMyPreferences,
        shouldAutocloseDMs,
        getCurrentChannelId,
        (state: GlobalState) => state.entities.users.profiles,
        getCurrentUserId,
        getMyChannelMemberships,
        getLastPostPerChannel,
        (channels, categoryType, myPreferences, autocloseDMs, currentChannelId, profiles, currentUserId, myMembers, lastPosts) => {
            if (categoryType !== CategoryTypes.DIRECT_MESSAGES) {
                // Only autoclose DMs that haven't been assigned to a category
                return channels;
            }

            // Ideally, this would come from a selector, but that would cause the filter to recompute too often
            const cutoff = getAutocloseCutoff();

            const filtered = channels.filter((channel) => {
                if (channel.type !== General.DM_CHANNEL && channel.type !== General.GM_CHANNEL) {
                    return true;
                }

                if (isUnreadChannel(myMembers, channel)) {
                    // Unread DMs/GMs are always visible
                    return true;
                }

                if (currentChannelId === channel.id) {
                    // The current channel is always visible
                    return true;
                }

                // viewTime is the time the channel was last viewed by the user
                const viewTimePref = myPreferences[getPreferenceKey(Preferences.CATEGORY_CHANNEL_APPROXIMATE_VIEW_TIME, channel.id)];
                const viewTime = parseInt(viewTimePref ? viewTimePref.value! : '0', 10);

                // Recently viewed channels will never be hidden. Note that viewTime is not set correctly at the time of writing.
                if (viewTime > cutoff) {
                    return true;
                }

                // openTime is the time the channel was last opened (like from the More DMs list) after having been closed
                const openTimePref = myPreferences[getPreferenceKey(Preferences.CATEGORY_CHANNEL_OPEN_TIME, channel.id)];
                const openTime = parseInt(openTimePref ? openTimePref.value! : '0', 10);

                // DMs with deactivated users will be visible if you're currently viewing them and they were opened
                // since the user was deactivated
                if (channel.type === General.DM_CHANNEL) {
                    const teammateId = getUserIdFromChannelName(currentUserId, channel.name);
                    const teammate = profiles[teammateId];

                    if (!teammate || teammate.delete_at > openTime) {
                        return false;
                    }
                }

                // Skip the rest of the checks if autoclosing inactive DMs is disabled
                if (!autocloseDMs) {
                    return true;
                }

                // Keep the channel open if it had a recent post. If we have posts loaded for the channel, use the create_at
                // of the last post in the channel since channel.last_post_at isn't kept up to date on the client. If we don't
                // have posts loaded, then fall back to the last_post_at.
                const lastPost = lastPosts[channel.id];

                if (lastPost && lastPost.create_at > cutoff) {
                    return true;
                }

                if (openTime > cutoff) {
                    return true;
                }

                if (channel.last_post_at && channel.last_post_at > cutoff) {
                    return true;
                }

                return false;
            });

            return filtered.length === channels.length ? channels : filtered;
        },
    );
}

export function makeFilterManuallyClosedDMs(): (state: GlobalState, channels: Channel[]) => Channel[] {
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        getMyPreferences,
        getCurrentChannelId,
        getCurrentUserId,
        getMyChannelMemberships,
        (channels, myPreferences, currentChannelId, currentUserId, myMembers) => {
            const filtered = channels.filter((channel) => {
                let preference;

                if (channel.type !== General.DM_CHANNEL && channel.type !== General.GM_CHANNEL) {
                    return true;
                }

                if (isUnreadChannel(myMembers, channel)) {
                    // Unread DMs/GMs are always visible
                    return true;
                }

                if (currentChannelId === channel.id) {
                    // The current channel is always visible
                    return true;
                }

                if (channel.type === General.DM_CHANNEL) {
                    const teammateId = getUserIdFromChannelName(currentUserId, channel.name);

                    preference = myPreferences[getPreferenceKey(Preferences.CATEGORY_DIRECT_CHANNEL_SHOW, teammateId)];
                } else {
                    preference = myPreferences[getPreferenceKey(Preferences.CATEGORY_GROUP_CHANNEL_SHOW, channel.id)];
                }

                return preference && preference.value !== 'false';
            });

            // Only return a new array if anything was removed
            return filtered.length === channels.length ? channels : filtered;
        },
    );
}

export function makeCompareChannels(getDisplayName: (channel: Channel) => string, locale: string, myMembers: RelationOneToOne<Channel, ChannelMembership>) {
    return (a: Channel, b: Channel) => {
        // Sort muted channels last
        const aMuted = isChannelMuted(myMembers[a.id]);
        const bMuted = isChannelMuted(myMembers[b.id]);

        if (aMuted && !bMuted) {
            return 1;
        } else if (!aMuted && bMuted) {
            return -1;
        }

        // And then sort alphabetically
        return getDisplayName(a).localeCompare(getDisplayName(b), locale, {numeric: true});
    };
}

export function makeSortChannelsByName(): (state: GlobalState, channels: Channel[]) => Channel[] {
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        getCurrentUserLocale,
        getMyChannelMemberships,
        (channels: Channel[], locale: string, myMembers: RelationOneToOne<Channel, ChannelMembership>) => {
            const getDisplayName = (channel: Channel) => channel.display_name;

            return [...channels].sort(makeCompareChannels(getDisplayName, locale, myMembers));
        },
    );
}

export function makeSortChannelsByNameWithDMs(): (state: GlobalState, channels: Channel[]) => Channel[] {
    return createSelector(
        (state: GlobalState, channels: Channel[]) => channels,
        getCurrentUserId,
        (state: GlobalState) => state.entities.users.profiles,
        getTeammateNameDisplaySetting,
        getCurrentUserLocale,
        getMyChannelMemberships,
        (channels: Channel[], currentUserId: string, profiles: IDMappedObjects<UserProfile>, teammateNameDisplay: string, locale: string, myMembers: RelationOneToOne<Channel, ChannelMembership>) => {
            const cachedNames: RelationOneToOne<Channel, string> = {};

            const getDisplayName = (channel: Channel): string => {
                if (cachedNames[channel.id]) {
                    return cachedNames[channel.id];
                }

                let displayName;

                // TODO it might be easier to do this by using channel members to find the users
                if (channel.type === General.DM_CHANNEL) {
                    const teammateId = getUserIdFromChannelName(currentUserId, channel.name);
                    const teammate = profiles[teammateId];

                    displayName = displayUsername(teammate, teammateNameDisplay, false);
                } else if (channel.type === General.GM_CHANNEL) {
                    const usernames = channel.display_name.split(', ');

                    const userDisplayNames = [];
                    for (const username of usernames) {
                        const user = Object.values(profiles).find((profile) => profile.username === username);

                        if (!user) {
                            continue;
                        }

                        if (user.id === currentUserId) {
                            continue;
                        }

                        userDisplayNames.push(displayUsername(user, teammateNameDisplay, false));
                    }

                    displayName = userDisplayNames.sort((a, b) => a.localeCompare(b, locale, {numeric: true})).join(', ');
                } else {
                    displayName = channel.display_name;
                }

                cachedNames[channel.id] = displayName;

                return displayName;
            };

            return [...channels].sort(makeCompareChannels(getDisplayName, locale, myMembers));
        },
    );
}

export function makeGetChannelsForCategory() {
    const getUnsortedUnfilteredChannels = makeGetUnsortedUnfilteredChannels();
    const filterAndSortChannelsForCategory = makeFilterAndSortChannelsForCategory();

    return (state: GlobalState, category: ChannelCategory) => {
        const channels = getUnsortedUnfilteredChannels(state, category.team_id);

        return filterAndSortChannelsForCategory(state, channels, category);
    };
}

export function makeFilterAndSortChannelsForCategory() {
    const filterChannelsByFavorites = makeFilterChannelsByFavorites();
    const filterChannelsByType = makeFilterChannelsByType();

    const filterAutoclosedDMs = makeFilterAutoclosedDMs();
    const filterManuallyClosedDMs = makeFilterManuallyClosedDMs();

    const sortChannelsByName = makeSortChannelsByName();
    const sortChannelsByNameWithDMs = makeSortChannelsByNameWithDMs();

    return (state: GlobalState, originalChannels: Channel[], category: ChannelCategory) => {
        let channels = originalChannels;

        channels = filterChannelsByFavorites(state, channels, category.type);
        channels = filterChannelsByType(state, channels, category.type);

        channels = filterAutoclosedDMs(state, channels, category.type);
        channels = filterManuallyClosedDMs(state, channels);

        if (channels.some((channel) => channel.type === General.DM_CHANNEL || channel.type === General.GM_CHANNEL)) {
            channels = sortChannelsByNameWithDMs(state, channels);
        } else {
            channels = sortChannelsByName(state, channels);
        }

        return channels;
    };
}

export function makeGetChannelsByCategory() {
    const getCategoriesForTeam = makeGetCategoriesForTeam();
    const getUnsortedUnfilteredChannels = makeGetUnsortedUnfilteredChannels();

    // Memoize filterAndSortChannels by category. As long as the categories don't change, we can keep using the same
    // selector for each category.
    let filterAndSortChannels: RelationOneToOne<ChannelCategory, ReturnType<typeof makeFilterAndSortChannelsForCategory>>;

    let lastCategoryIds: ReturnType<typeof getCategoryIdsForTeam> = [];
    let lastChannelsByCategory: RelationOneToOne<ChannelCategory, Channel[]> = {};

    return (state: GlobalState, teamId: string) => {
        const categoryIds = getCategoryIdsForTeam(state, teamId);

        // Create an instance of filterAndSortChannels for each category. As long as we don't add or remove new categories,
        // we can reuse these selectors to memoize the results of each category. This will also create new selectors when
        // categories are reordered, but that should be rare enough that it won't meaningfully affect performance.
        if (categoryIds !== lastCategoryIds) {
            lastCategoryIds = categoryIds;
            lastChannelsByCategory = {};

            filterAndSortChannels = {};

            if (categoryIds) {
                for (const categoryId of categoryIds) {
                    filterAndSortChannels[categoryId] = makeFilterAndSortChannelsForCategory();
                }
            }
        }

        const categories = getCategoriesForTeam(state, teamId);
        const channels = getUnsortedUnfilteredChannels(state, teamId);

        const channelsByCategory: RelationOneToOne<ChannelCategory, Channel[]> = {};

        for (const category of categories) {
            channelsByCategory[category.id] = filterAndSortChannels[category.id](state, channels, category);
        }

        // Do a shallow equality check of channelsByCategory to avoid returning a new object containing the same data
        if (shallowEquals(channelsByCategory, lastChannelsByCategory)) {
            return lastChannelsByCategory;
        }

        lastChannelsByCategory = channelsByCategory;
        return channelsByCategory;
    };
}
