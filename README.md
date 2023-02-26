# ytm-playlist-importer

Import csv playlist to your YouTube Music

- Get you an Oauth2 client secret from Google with the youtube scope. Redirect URI should be 'http://localhost:8080'
- Put it in the root with the name 'client_secret.json'
- Start a basic redis instance in Docker or something locally... This was mostly for dev so I didn't keep hitting my quota so maybe I'll remove it
- Export all your spotify playlists to .csv. I used this: 'https://watsonbox.github.io/exportify/'
- Put those in the /playlists folder. Delete all mine first. Or not.
- Then I think you're good. just run `yarn start` and select the playlist you want to import. The problem is going to be the free quota for the youtube API. It's currently at 10000 units. Currently like a 100 song playlist will chew through that. You may have to run it again after it resets. It should check if the playlist/song already exists and pick up add the ones that don't.
