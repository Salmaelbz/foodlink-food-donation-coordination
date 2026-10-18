PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('donor', 'community_partner', 'transport', 'pilot')),
    contact_name TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    service_area TEXT NOT NULL DEFAULT '',
    participation_status TEXT NOT NULL DEFAULT 'active'
        CHECK (participation_status IN ('active', 'paused', 'pending')),
    capabilities TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('administrator', 'coordinator', 'donor', 'partner', 'driver')),
    organization_id TEXT REFERENCES organizations(id),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL,
    pickup_location TEXT NOT NULL,
    pickup_from TEXT NOT NULL,
    pickup_until TEXT NOT NULL,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    use_by TEXT,
    storage_requirements TEXT NOT NULL DEFAULT '',
    transport_requirements TEXT NOT NULL DEFAULT '',
    allergens TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'approved', 'rejected')),
    safety_checklist TEXT NOT NULL DEFAULT '{}',
    rejection_reason TEXT,
    coordinator_notes TEXT NOT NULL DEFAULT '',
    submission_key TEXT,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'under_review', 'approved', 'matched', 'scheduled', 'collected', 'delivered', 'rejected', 'cancelled', 'unresolved')),
    created_by TEXT NOT NULL REFERENCES profiles(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (pickup_until >= pickup_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_submission_key ON donations(created_by, submission_key);
CREATE INDEX IF NOT EXISTS idx_donations_status_category ON donations(status, category);
CREATE INDEX IF NOT EXISTS idx_donations_org ON donations(organization_id);

CREATE TABLE IF NOT EXISTS food_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    categories TEXT NOT NULL,
    description TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL,
    destination TEXT NOT NULL,
    required_by TEXT NOT NULL,
    handling_requirements TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'partially_fulfilled', 'fulfilled', 'expired', 'cancelled')),
    coordinator_notes TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES profiles(id),
    submission_key TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_submission_key ON food_requests(created_by, submission_key);
CREATE INDEX IF NOT EXISTS idx_requests_status_required ON food_requests(status, required_by);
CREATE INDEX IF NOT EXISTS idx_requests_org ON food_requests(organization_id);

CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    donation_id TEXT NOT NULL REFERENCES donations(id),
    request_id TEXT NOT NULL REFERENCES food_requests(id),
    proposed_quantity REAL NOT NULL CHECK (proposed_quantity > 0),
    unit TEXT NOT NULL,
    proposed_pickup TEXT NOT NULL,
    proposed_delivery TEXT NOT NULL,
    transport_feasible INTEGER NOT NULL DEFAULT 0 CHECK (transport_feasible IN (0, 1)),
    timing_feasible INTEGER NOT NULL DEFAULT 0 CHECK (timing_feasible IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'confirmed', 'cancelled', 'declined')),
    created_by TEXT NOT NULL REFERENCES profiles(id),
    confirmed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_donation ON matches(donation_id);
CREATE INDEX IF NOT EXISTS idx_matches_request ON matches(request_id);

CREATE TABLE IF NOT EXISTS match_approvals (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL REFERENCES matches(id),
    role TEXT NOT NULL CHECK (role IN ('donor', 'partner')),
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, role)
);

CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL UNIQUE REFERENCES matches(id),
    donor_organization_id TEXT NOT NULL REFERENCES organizations(id),
    receiving_organization_id TEXT NOT NULL REFERENCES organizations(id),
    pickup_location TEXT NOT NULL,
    destination TEXT NOT NULL,
    scheduled_pickup TEXT NOT NULL,
    scheduled_delivery TEXT NOT NULL,
    coordinator_id TEXT NOT NULL REFERENCES profiles(id),
    driver_id TEXT REFERENCES profiles(id),
    quantity_expected REAL NOT NULL CHECK (quantity_expected > 0),
    unit TEXT NOT NULL,
    quantity_collected REAL,
    quantity_received REAL,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'pickup_in_progress', 'collected', 'in_transit', 'delivered', 'pickup_failed', 'delayed', 'partially_delivered', 'rejected_on_arrival', 'cancelled', 'unresolved')),
    handling_instructions TEXT NOT NULL DEFAULT '',
    confirmation_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_schedule ON deliveries(status, scheduled_pickup);
CREATE INDEX IF NOT EXISTS idx_deliveries_driver ON deliveries(driver_id);

CREATE TABLE IF NOT EXISTS delivery_assignments (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    assigned_by TEXT NOT NULL REFERENCES profiles(id),
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'driver')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(delivery_id, profile_id, role)
);

CREATE TABLE IF NOT EXISTS delivery_confirmations (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    confirmed_by TEXT NOT NULL REFERENCES profiles(id),
    quantity_expected REAL NOT NULL,
    quantity_received REAL NOT NULL CHECK (quantity_received >= 0),
    unit TEXT NOT NULL,
    condition_on_arrival TEXT NOT NULL,
    acceptance TEXT NOT NULL CHECK (acceptance IN ('accepted', 'partially_accepted', 'rejected')),
    confirmation_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correction_of TEXT REFERENCES delivery_confirmations(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_confirmations_delivery ON delivery_confirmations(delivery_id, created_at);

CREATE TABLE IF NOT EXISTS delivery_issues (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    follow_up_action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'under_investigation', 'resolved', 'closed')),
    created_by TEXT NOT NULL REFERENCES profiles(id),
    assigned_to TEXT REFERENCES profiles(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON delivery_issues(status);

CREATE TABLE IF NOT EXISTS partner_feedback (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    ease_rating INTEGER CHECK (ease_rating BETWEEN 1 AND 5),
    communication_rating INTEGER CHECK (communication_rating BETWEEN 1 AND 5),
    reliability_rating INTEGER CHECK (reliability_rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    profile_id TEXT REFERENCES profiles(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_profile ON notifications(profile_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS pilot_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pilot_name TEXT NOT NULL DEFAULT 'FoodLink Community Pilot',
    district TEXT NOT NULL DEFAULT 'Neighborhood to be confirmed',
    start_date TEXT,
    end_date TEXT,
    accepted_categories TEXT NOT NULL DEFAULT '[]',
    accepted_units TEXT NOT NULL DEFAULT '["kg","items","boxes","litres"]',
    safety_checklist TEXT NOT NULL DEFAULT '[]',
    scheduling_rules TEXT NOT NULL DEFAULT '',
    transport_capacity TEXT NOT NULL DEFAULT '',
    privacy_policy TEXT NOT NULL DEFAULT 'Collect only operational coordination data.',
    retention_policy TEXT NOT NULL DEFAULT 'Retention period to be confirmed by the pilot team.',
    external_notifications_configured INTEGER NOT NULL DEFAULT 0 CHECK (external_notifications_configured IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO pilot_settings (id) VALUES (1);
