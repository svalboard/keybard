export type QMKSettings = {
    tabs: QMKSettingsTab[];
};

export type QMKSettingsTab = {
    name: string;
    fields: QMKSettingsField[];
};

type QMKSettingsBooleanField = {
    type: 'boolean';
    title: string;
    qsid: number;
    width?: number;
    bit?: number;  // Optional: if not provided, uses the whole value as boolean
};

type QMKSettingsIntegerField = {
    type: 'integer';
    title: string;
    qsid: number;
    min: number;
    max: number;
    width: number;
    /** Stored and reported, but the firmware doesn't use it, so no screen shows it. */
    hidden?: boolean;
};

export type QMKSettingsField = QMKSettingsBooleanField | QMKSettingsIntegerField;
