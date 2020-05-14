// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import {Channel} from './channels';
import {Team} from './teams';
import {PostType} from './posts';
import {$ID, IDMappedObjects, RelationOneToMany, RelationOneToOne} from './utilities';
export type UserNotifyProps = {
    desktop: 'default' | 'all' | 'mention' | 'none';
    desktop_sound: 'true' | 'false';
    email: 'true' | 'false';
    mark_unread: 'all' | 'mention';
    push: 'default' | 'all' | 'mention' | 'none';
    push_status: 'ooo' | 'offline' | 'away' | 'dnd' | 'online';
    comments: 'never' | 'root' | 'any';
    first_name: 'true' | 'false';
    channel: 'true' | 'false';
    mention_keys: string;
};
export type UserProfile = {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    username: string;
    auth_data: string;
    auth_service: string;
    email: string;
    email_verified: boolean;
    nickname: string;
    first_name: string;
    last_name: string;
    position: string;
    roles: string;
    locale: string;
    notify_props: UserNotifyProps;
    terms_of_service_id: string;
    terms_of_service_create_at: number;
    timezone?: UserTimezone;
    is_bot: boolean;
    last_picture_update: number;
};
export type UsersState = {
    currentUserId: string;
    isManualStatus: RelationOneToOne<UserProfile, boolean>;
    mySessions: Array<any>;
    myAudits: Array<any>;
    profiles: IDMappedObjects<UserProfile>;
    profilesInTeam: RelationOneToMany<Team, UserProfile>;
    profilesNotInTeam: RelationOneToMany<Team, UserProfile>;
    profilesWithoutTeam: Set<string>;
    profilesInChannel: RelationOneToMany<Channel, UserProfile>;
    profilesNotInChannel: RelationOneToMany<Channel, UserProfile>;
    statuses: RelationOneToOne<UserProfile, string>;
    stats: any;
};
export type UserTimezone = {
    useAutomaticTimezone: boolean | string;
    automaticTimezone: string;
    manualTimezone: string;
};
export type UserActivity = {
    [x in PostType]: {
        [x in $ID<UserProfile>]: | {
            ids: Array<$ID<UserProfile>>;
            usernames: Array<UserProfile['username']>;
        } | Array<$ID<UserProfile>>;
    };
};

export type UserStatus = {
	user_id: string;
	status: string;
	manual: boolean;
	last_activity_at: number;
	active_channel?: string;
}
